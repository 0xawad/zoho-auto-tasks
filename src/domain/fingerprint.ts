import { createHash } from "node:crypto"

/** Stable JSON: key order must not change a hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(",")}}`
}

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex")
}

/** Detects that a draft changed after validation. Not a duplicate key. */
export function payloadHash(payload: unknown): string {
  return sha256(stableStringify(payload))
}

export function normalizeSubject(subject: string): string {
  return subject
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/**
 * Cross-batch duplicate signal: same tenant scope, same day, same activity.
 * Deliberately excludes wording nuance so a reworded resubmission is caught,
 * and deliberately includes the work date so genuinely repeated work on a
 * different day is never suppressed.
 */
export function contentFingerprint(input: {
  orgId: string
  departmentId: string | null
  ownerId: string | null
  workDate: string
  subject: string
}): string {
  return sha256(
    [
      input.orgId,
      input.departmentId ?? "",
      input.ownerId ?? "",
      input.workDate,
      normalizeSubject(input.subject),
    ].join("\u0000"),
  )
}
