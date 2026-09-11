/**
 * Redaction is applied to every message that can reach a log, a tool result or
 * the model. Zoho tokens have a recognisable shape (`1000.<hex>.<hex>`), and we
 * additionally scrub anything registered as a live secret at runtime.
 */

const registered = new Set<string>()

/** Register a secret value so it can be scrubbed from any outgoing text. */
export function registerSecret(value: string | null | undefined): void {
  if (typeof value === "string" && value.length >= 8) registered.add(value)
}

const PATTERNS: Array<[RegExp, string]> = [
  // Zoho OAuth access/refresh tokens
  [/\b1000\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<redacted-zoho-token>"],
  // Authorization headers in any casing
  [/(authorization"?\s*[:=]\s*"?)(zoho-oauthtoken|bearer)\s+\S+/gi, "$1$2 <redacted>"],
  // Credential-bearing JSON/form keys. Deliberately specific: a generic "code"
  // key would redact ordinary error payloads and make diagnostics useless.
  [
    /("?(?:access_token|refresh_token|client_secret|clientSecret|refreshToken|authorization_code)"?\s*[:=]\s*"?)([^",&\s}]+)/gi,
    "$1<redacted>",
  ],
]

export function redact(input: string): string {
  let out = input
  for (const secret of registered) {
    if (secret && out.includes(secret)) out = out.split(secret).join("<redacted>")
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

export function redactUnknown(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return redact(value)
  if (value instanceof Error) return redact(value.message)
  try {
    return redact(JSON.stringify(value))
  } catch {
    return redact(String(value))
  }
}

/** Truncate a message so a huge upstream body cannot flood logs or context. */
export function clip(text: string, max = 600): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}… (${text.length - max} more characters)`
}
