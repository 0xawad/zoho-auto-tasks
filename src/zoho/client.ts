import type { Config } from "../config/config.ts"
import type { TokenManager } from "./oauth.ts"
import { ZohoError, categorize, parseRetryAfter, type FieldError } from "./errors.ts"
import { redact, clip } from "../util/redact.ts"

type FetchImpl = typeof globalThis.fetch

export type RequestOptions = {
  method?: "GET" | "POST" | "PATCH"
  query?: Record<string, string | number | boolean | null | undefined>
  body?: unknown
  /**
   * Writes are never retried automatically on an ambiguous failure. A timeout
   * or 5xx after sending a create may mean the task exists. The caller must
   * reconcile instead of replaying. See docs/zoho-field-map.md §5.
   */
  isWrite?: boolean
}

export type RequestResult<T> = {
  data: T
  status: number
  creditsUsed: number | null
  creditsRemaining: number | null
}

export class DeskClient {
  private readonly config: Config
  private readonly tokens: TokenManager
  private readonly fetchImpl: FetchImpl
  private readonly sleep: (ms: number) => Promise<void>
  private orgIdOverride: string | null = null

  constructor(
    config: Config,
    tokens: TokenManager,
    opts: { fetchImpl?: FetchImpl; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.config = config
    this.tokens = tokens
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /**
   * Use a specific organization for subsequent calls. Needed during discovery,
   * before the org ID is known and written to the configuration.
   */
  setOrgId(orgId: string): void {
    this.orgIdOverride = orgId
  }

  /** The org ID that will actually be sent, if it is usable at all. */
  effectiveOrgId(): string | null {
    const value = this.orgIdOverride ?? this.config.orgId
    return /^[0-9]+$/.test(value) ? value : null
  }

  async request<T = any>(pathname: string, opts: RequestOptions = {}): Promise<RequestResult<T>> {
    const isWrite = opts.isWrite === true
    const maxAttempts = isWrite ? 1 : this.config.limits.maxRetries + 1
    let refreshed = false
    let attempt = 0

    for (;;) {
      attempt += 1
      try {
        return await this.attempt<T>(pathname, opts, refreshed)
      } catch (err) {
        if (!(err instanceof ZohoError)) throw err

        // One controlled refresh-and-retry, only for a definitive auth rejection.
        if (err.category === "auth" && !refreshed) {
          refreshed = true
          this.tokens.invalidate()
          attempt -= 1
          continue
        }

        const transient = err.category === "concurrency" || err.category === "server" || err.category === "network"
        if (!transient || attempt >= maxAttempts) throw err

        const waitMs = err.retryAfterSeconds
          ? err.retryAfterSeconds * 1000
          : backoffMs(attempt)
        await this.sleep(waitMs)
      }
    }
  }

  private async attempt<T>(
    pathname: string,
    opts: RequestOptions,
    forceRefresh: boolean,
  ): Promise<RequestResult<T>> {
    const { accessToken, apiDomain } = await this.tokens.getAccessToken({ forceRefresh })
    const url = new URL(`${apiDomain}/api/v1${pathname}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      Accept: "application/json",
    }
    // Sending a placeholder org ID makes Zoho fail with an opaque 500, so the
    // header is omitted unless it is a real numeric ID. The token is org-bound,
    // so Zoho resolves the organization itself when the header is absent.
    const orgId = this.effectiveOrgId()
    if (orgId) headers.orgId = orgId
    if (opts.body !== undefined) headers["Content-Type"] = "application/json"

    let response: Response
    try {
      response = await this.fetchImpl(url.toString(), {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.config.limits.requestTimeoutMs),
      })
    } catch (err: any) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError"
      throw new ZohoError({
        message: timedOut
          ? `Request to ${url.pathname} timed out after ${this.config.limits.requestTimeoutMs}ms.`
          : `Network failure calling ${url.pathname}: ${redact(err?.message ?? String(err))}`,
        category: "network",
      })
    }

    const creditsUsed = numberHeader(response, "X-Rate-Limit-Request-Weight-v3")
    const creditsRemaining = numberHeader(response, "X-Rate-Limit-Remaining-v3")
    const text = await response.text()

    if (!response.ok) {
      throw buildError(response, text, url.pathname)
    }

    let data: any = null
    if (text.trim().length) {
      try {
        data = JSON.parse(text)
      } catch {
        throw new ZohoError({
          message: `Zoho returned a non-JSON success body for ${url.pathname}.`,
          category: "unknown",
          status: response.status,
        })
      }
    }
    return { data: data as T, status: response.status, creditsUsed, creditsRemaining }
  }
}

function numberHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name)
  if (raw === null) return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : null
}

function buildError(response: Response, text: string, pathname: string): ZohoError {
  let payload: any = null
  try {
    payload = text.trim().length ? JSON.parse(text) : null
  } catch {
    /* body is not JSON; fall through to a generic message */
  }

  const errorCode: string | null = typeof payload?.errorCode === "string" ? payload.errorCode : null
  const fieldErrors: FieldError[] = Array.isArray(payload?.errors)
    ? payload.errors
        .filter((e: any) => e && typeof e.fieldName === "string")
        .map((e: any) => ({ fieldName: e.fieldName, errorType: String(e.errorType ?? "invalid") }))
    : []

  const category = categorize(response.status, errorCode)
  const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"))
  const upstream = typeof payload?.message === "string" ? payload.message : clip(text, 200)

  return new ZohoError({
    message: explain(category, errorCode, upstream, pathname, response.status),
    category,
    status: response.status,
    errorCode,
    fieldErrors,
    retryAfterSeconds,
  })
}

function explain(
  category: string,
  errorCode: string | null,
  upstream: string,
  pathname: string,
  status: number,
): string {
  switch (errorCode) {
    case "SCOPE_MISMATCH":
      return (
        `The OAuth token lacks the scope required for ${pathname}. Regenerate the refresh token ` +
        `with the scope set documented in README.md.`
      )
    case "OAUTH_ORG_MISMATCH":
      return (
        `The configured orgId does not match the organization the OAuth token belongs to. ` +
        `Check 'orgId' in your config, or regenerate the token against the intended portal.`
      )
    case "THRESHOLD_EXCEEDED":
      return `The Zoho portal has used its daily API credit allowance. No further calls will succeed today.`
    case "TOO_MANY_REQUESTS":
      return `Zoho concurrency limit reached. Reduce parallelism and retry.`
    case "INVALID_DATA":
      return `Zoho rejected the data as invalid: ${upstream}`
    default:
      return `Zoho request to ${pathname} failed (HTTP ${status}, ${category}): ${upstream}`
  }
}

/** Exponential backoff with full jitter, capped. */
export function backoffMs(attempt: number, base = 500, cap = 8000): number {
  const exponential = Math.min(cap, base * 2 ** (attempt - 1))
  return Math.round(Math.random() * exponential)
}
