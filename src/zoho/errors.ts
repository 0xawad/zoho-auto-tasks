import { redact, clip } from "../util/redact.ts"

/**
 * Error categories drive retry, batch-stop and uncertainty decisions.
 * See docs/zoho-field-map.md §8 for the sourced behaviour of each.
 */
export type ErrorCategory =
  /** 401 / INVALID_OAUTH. One refresh-and-retry is allowed. */
  | "auth"
  /** 403 SCOPE_MISMATCH, OAUTH_ORG_MISMATCH, FORBIDDEN. Configuration is wrong; stop. */
  | "config"
  /** 400 / 422 INVALID_DATA. Definitive rejection; no write happened. */
  | "validation"
  /** 429 THRESHOLD_EXCEEDED. Daily credits gone; stop the batch. */
  | "credits"
  /** 429 TOO_MANY_REQUESTS. Concurrency limit; back off briefly and retry. */
  | "concurrency"
  /** 5xx. A write may or may not have landed. */
  | "server"
  /** Timeout, connection reset, DNS. A write may or may not have landed. */
  | "network"
  /** 404. */
  | "notfound"
  | "unknown"

export type FieldError = { fieldName: string; errorType: string }

export class ZohoError extends Error {
  readonly category: ErrorCategory
  readonly status: number | null
  readonly errorCode: string | null
  readonly fieldErrors: FieldError[]
  readonly retryAfterSeconds: number | null

  constructor(opts: {
    message: string
    category: ErrorCategory
    status?: number | null
    errorCode?: string | null
    fieldErrors?: FieldError[]
    retryAfterSeconds?: number | null
  }) {
    super(clip(redact(opts.message)))
    this.name = "ZohoError"
    this.category = opts.category
    this.status = opts.status ?? null
    this.errorCode = opts.errorCode ?? null
    this.fieldErrors = opts.fieldErrors ?? []
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null
  }

  /** True when a failed write leaves the outcome genuinely unknown. */
  get writeOutcomeUnknown(): boolean {
    return this.category === "server" || this.category === "network"
  }

  /** True when continuing the rest of the batch is pointless or harmful. */
  get stopsBatch(): boolean {
    return this.category === "config" || this.category === "credits" || this.category === "auth"
  }

  /** Safe, structured summary for persistence and for the model. */
  toSafeJSON() {
    return {
      category: this.category,
      status: this.status,
      errorCode: this.errorCode,
      message: this.message,
      fieldErrors: this.fieldErrors,
      retryAfterSeconds: this.retryAfterSeconds,
    }
  }
}

const CONFIG_CODES = new Set(["SCOPE_MISMATCH", "OAUTH_ORG_MISMATCH", "FORBIDDEN", "LICENSE_ACCESS_LIMITED"])
const AUTH_CODES = new Set(["UNAUTHORIZED", "INVALID_OAUTH"])

/**
 * Map an HTTP response onto a category.
 *
 * The important subtlety: HTTP 429 has two distinct meanings that need
 * different handling, so we branch on errorCode rather than on status.
 */
export function categorize(status: number, errorCode: string | null): ErrorCategory {
  if (errorCode && AUTH_CODES.has(errorCode)) return "auth"
  if (errorCode && CONFIG_CODES.has(errorCode)) return "config"
  if (errorCode === "THRESHOLD_EXCEEDED") return "credits"
  if (errorCode === "TOO_MANY_REQUESTS") return "concurrency"

  if (status === 401) return "auth"
  if (status === 403) return "config"
  if (status === 404) return "notfound"
  if (status === 400 || status === 422 || status === 413 || status === 415) return "validation"
  if (status === 429) return "concurrency"
  if (status >= 500) return "server"
  return "unknown"
}

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  const seconds = Number.parseInt(header, 10)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, Math.round((date - Date.now()) / 1000))
  return null
}
