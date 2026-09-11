import fs from "node:fs"
import path from "node:path"
import { accountsHost, fallbackDeskHost, type Config, type Secrets } from "../config/config.ts"
import { resolveDeskBase } from "../config/regions.ts"
import { tokenCacheFile, writeSecureJson, readJsonIfExists, ensureDir } from "../config/paths.ts"
import { registerSecret, redact } from "../util/redact.ts"
import { ZohoError } from "./errors.ts"

/**
 * Zoho access tokens live one hour, and Zoho throttles token requests to ten
 * per ten minutes per refresh token. Refreshing per process would exhaust that
 * quota quickly, so the token is cached on disk (0600) and shared across every
 * invocation. See docs/zoho-field-map.md §7.
 */

const EXPIRY_MARGIN_MS = 120_000
const LOCK_STALE_MS = 30_000

export type TokenCache = {
  accessToken: string
  expiresAt: number
  apiDomain: string
}

export type AccessToken = {
  accessToken: string
  apiDomain: string
}

type FetchImpl = typeof globalThis.fetch

export type TokenManagerOptions = {
  fetchImpl?: FetchImpl
  cacheFile?: string
  now?: () => number
}

export class TokenManager {
  private readonly config: Config
  private readonly secrets: Secrets
  private readonly fetchImpl: FetchImpl
  private readonly cacheFile: string
  private readonly now: () => number
  private inFlight: Promise<AccessToken> | null = null

  constructor(config: Config, secrets: Secrets, opts: TokenManagerOptions = {}) {
    this.config = config
    this.secrets = secrets
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.cacheFile = opts.cacheFile ?? tokenCacheFile()
    this.now = opts.now ?? Date.now
    registerSecret(secrets.clientSecret)
    registerSecret(secrets.refreshToken)
  }

  private readCache(): TokenCache | null {
    const raw = readJsonIfExists(this.cacheFile) as TokenCache | null
    if (!raw || typeof raw.accessToken !== "string" || typeof raw.expiresAt !== "number") return null
    if (typeof raw.apiDomain !== "string") return null
    return raw
  }

  private fresh(cache: TokenCache | null): boolean {
    return !!cache && cache.expiresAt - EXPIRY_MARGIN_MS > this.now()
  }

  /** Returns a usable access token, refreshing only when necessary. */
  async getAccessToken(opts: { forceRefresh?: boolean } = {}): Promise<AccessToken> {
    if (!opts.forceRefresh) {
      const cache = this.readCache()
      if (this.fresh(cache)) {
        registerSecret(cache!.accessToken)
        return { accessToken: cache!.accessToken, apiDomain: cache!.apiDomain }
      }
    }
    // Single-flight within this process.
    if (this.inFlight) return this.inFlight
    this.inFlight = this.refreshSerialized(opts.forceRefresh === true).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** Drop the cached token, e.g. after a definitive 401. */
  invalidate(): void {
    try {
      fs.rmSync(this.cacheFile, { force: true })
    } catch {
      /* cache removal is best-effort */
    }
  }

  /** Serialize refreshes across processes so concurrent runs do not burn quota. */
  private async refreshSerialized(force: boolean): Promise<AccessToken> {
    const lockFile = `${this.cacheFile}.lock`
    ensureDir(path.dirname(this.cacheFile))
    const acquired = await this.acquireLock(lockFile)
    try {
      // Another process may have refreshed while we waited for the lock.
      if (!force) {
        const cache = this.readCache()
        if (this.fresh(cache)) {
          registerSecret(cache!.accessToken)
          return { accessToken: cache!.accessToken, apiDomain: cache!.apiDomain }
        }
      }
      return await this.refresh()
    } finally {
      if (acquired) {
        try {
          fs.rmSync(lockFile, { force: true })
        } catch {
          /* lock removal is best-effort */
        }
      }
    }
  }

  private async acquireLock(lockFile: string): Promise<boolean> {
    const deadline = this.now() + 15_000
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, "wx", 0o600)
        fs.writeSync(fd, String(process.pid))
        fs.closeSync(fd)
        return true
      } catch (err: any) {
        if (err?.code !== "EEXIST") return false
        try {
          const age = this.now() - fs.statSync(lockFile).mtimeMs
          if (age > LOCK_STALE_MS) {
            fs.rmSync(lockFile, { force: true })
            continue
          }
        } catch {
          continue
        }
        if (this.now() > deadline) return false
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }

  private async refresh(): Promise<AccessToken> {
    const url = `${accountsHost(this.config)}/oauth/v2/token`
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.secrets.clientId,
      client_secret: this.secrets.clientSecret,
      refresh_token: this.secrets.refreshToken,
    })

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(this.config.limits.requestTimeoutMs),
      })
    } catch (err: any) {
      throw new ZohoError({
        message: `Could not reach the Zoho accounts server at ${accountsHost(this.config)}: ${redact(
          err?.message ?? String(err),
        )}`,
        category: "network",
      })
    }

    const text = await response.text()
    let payload: any
    try {
      payload = JSON.parse(text)
    } catch {
      throw new ZohoError({
        message: `Zoho token endpoint returned a non-JSON response (HTTP ${response.status}).`,
        category: response.status >= 500 ? "server" : "unknown",
        status: response.status,
      })
    }

    // Zoho reports token failures with HTTP 200 and an `error` field.
    if (payload.error) {
      throw tokenError(String(payload.error), payload.error_description, response.status)
    }
    if (!response.ok) {
      throw new ZohoError({
        message: `Zoho token endpoint failed with HTTP ${response.status}.`,
        category: response.status >= 500 ? "server" : "config",
        status: response.status,
      })
    }
    if (typeof payload.access_token !== "string") {
      throw new ZohoError({
        message: "Zoho token response contained no access_token.",
        category: "unknown",
        status: response.status,
      })
    }

    // Zoho returns the generic APIs domain (e.g. www.zohoapis.com), which is not
    // where the Desk API lives, so it is mapped to the matching Desk host.
    const resolved = resolveDeskBase(payload.api_domain, fallbackDeskHost(this.config))
    const apiDomain = resolved.base

    const expiresInSeconds = Number(payload.expires_in) || 3600
    const cache: TokenCache = {
      accessToken: payload.access_token,
      expiresAt: this.now() + expiresInSeconds * 1000,
      apiDomain,
    }
    registerSecret(cache.accessToken)
    writeSecureJson(this.cacheFile, cache)
    return { accessToken: cache.accessToken, apiDomain: cache.apiDomain }
  }
}

function tokenError(code: string, description: unknown, status: number): ZohoError {
  const desc = typeof description === "string" ? ` (${description})` : ""
  switch (code) {
    case "invalid_client":
      return new ZohoError({
        message:
          "Zoho rejected the client credentials. Check ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET, " +
          "and confirm the configured region matches the data centre the client was created in.",
        category: "config",
        status,
        errorCode: code,
      })
    case "invalid_code":
    case "invalid_grant":
      return new ZohoError({
        message:
          "The Zoho refresh token is invalid or has been revoked. Writes are stopped. " +
          "Generate a new self-client authorization code at https://api-console.zoho.com and " +
          "exchange it for a new refresh token, then update your credentials.",
        category: "config",
        status,
        errorCode: code,
      })
    case "Access Denied":
      return new ZohoError({
        message:
          "Zoho is throttling token requests (limit: 10 per 10 minutes). " +
          "The cached access token should normally prevent this. Wait a few minutes and retry.",
        category: "concurrency",
        status,
        errorCode: code,
      })
    default:
      return new ZohoError({
        message: `Zoho token request failed: ${code}${desc}`,
        category: "config",
        status,
        errorCode: code,
      })
  }
}
