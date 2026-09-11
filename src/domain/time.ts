/**
 * Timezone handling without a dependency, using the ICU data both Node 22 and
 * Bun 1.3 ship with.
 *
 * Zoho requires UTC timestamps with a literal trailing Z and rejects offsets
 * (docs/zoho-field-map.md §4), so every local wall-clock time is resolved in the
 * configured IANA zone and converted here. DST gaps and repeated hours are
 * detected and reported rather than silently coerced.
 */

const CACHE = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = CACHE.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    CACHE.set(timeZone, f)
  }
  return f
}

export type WallClock = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** The wall-clock reading in `timeZone` at a given UTC instant. */
export function wallClockAt(utcMs: number, timeZone: string): WallClock {
  const parts = formatter(timeZone).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0")
  // Intl renders midnight as hour 24 in some locales/engines; normalise it.
  const hour = get("hour") % 24
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  }
}

function wallToUtcNaive(w: WallClock): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, 0)
}

function offsetMsAt(utcMs: number, timeZone: string): number {
  return wallToUtcNaive(wallClockAt(utcMs, timeZone)) - utcMs
}

function sameWall(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  )
}

export type Resolution =
  | { kind: "ok"; utcMs: number }
  /** The local time does not exist (spring-forward gap). */
  | { kind: "nonexistent" }
  /** The local time occurs twice (autumn fall-back). Needs clarification. */
  | { kind: "ambiguous"; options: number[] }

/**
 * Convert a local wall-clock time in `timeZone` to a UTC instant, reporting
 * DST gaps and repeats instead of guessing.
 */
export function resolveWallClock(w: WallClock, timeZone: string): Resolution {
  const naive = wallToUtcNaive(w)
  const candidates = new Set<number>()
  for (const probe of [naive, naive - 86_400_000, naive + 86_400_000]) {
    const offset = offsetMsAt(probe, timeZone)
    candidates.add(naive - offset)
  }
  const valid = [...candidates].filter((utcMs) => sameWall(wallClockAt(utcMs, timeZone), w)).sort((a, b) => a - b)

  if (valid.length === 0) return { kind: "nonexistent" }
  if (valid.length === 1) return { kind: "ok", utcMs: valid[0]! }
  return { kind: "ambiguous", options: valid }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/

export function parseDateParts(date: string): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(date)
  if (!m) throw new Error(`Expected a date in YYYY-MM-DD form, received ${JSON.stringify(date)}`)
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`${date} is not a valid calendar date`)
  }
  // Reject things like 2026-02-30 that Date.UTC would silently roll over.
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`${date} is not a valid calendar date`)
  }
  return { year, month, day }
}

export function parseTimeParts(time: string): { hour: number; minute: number; second: number } {
  const m = TIME_RE.exec(time)
  if (!m) throw new Error(`Expected a time in HH:MM or HH:MM:SS form, received ${JSON.stringify(time)}`)
  const hour = Number(m[1])
  const minute = Number(m[2])
  const second = Number(m[3] ?? "0")
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`${time} is not a valid time of day`)
  }
  return { hour, minute, second }
}

/** Today's calendar date in the configured zone, as YYYY-MM-DD. */
export function todayInZone(timeZone: string, now: number = Date.now()): string {
  const w = wallClockAt(now, timeZone)
  return `${String(w.year).padStart(4, "0")}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`
}

export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDateParts(date)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return shifted.toISOString().slice(0, 10)
}

/**
 * Resolve relative wording once, at batch creation, and persist the result.
 * Returns null when the wording is not a recognised relative date.
 */
export function resolveRelativeDate(word: string, timeZone: string, now: number = Date.now()): string | null {
  const key = word.trim().toLowerCase()
  const today = todayInZone(timeZone, now)
  if (key === "today") return today
  if (key === "yesterday") return addDays(today, -1)
  if (key === "tomorrow") return addDays(today, 1)
  if (DATE_RE.test(key)) {
    parseDateParts(key)
    return key
  }
  return null
}

/** Zoho's accepted timestamp format: yyyy-MM-ddTHH:mm:ss.SSSZ */
export function toZohoTimestamp(utcMs: number): string {
  return new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, ".000Z")
}

export function isZohoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)
}

/**
 * A calendar date carries no time of day, but Zoho's dueDate is a timestamp.
 * Local noon is used as the marker: it renders as the intended date in the
 * user's own timezone and, unlike midnight, can never land in a DST gap
 * (Beirut's transitions happen at 00:00).
 */
export const DATE_MARKER_HOUR = 12

export function dateToZohoTimestamp(date: string, timeZone: string): string {
  const { year, month, day } = parseDateParts(date)
  const resolved = resolveWallClock(
    { year, month, day, hour: DATE_MARKER_HOUR, minute: 0, second: 0 },
    timeZone,
  )
  if (resolved.kind !== "ok") {
    // Defensive: noon is not a transition time in any current zone.
    throw new Error(`Could not resolve ${date} ${DATE_MARKER_HOUR}:00 in ${timeZone} (${resolved.kind})`)
  }
  return toZohoTimestamp(resolved.utcMs)
}

/** Render a UTC instant back in the user's zone for previews and results. */
export function formatInZone(utcMs: number, timeZone: string): string {
  const w = wallClockAt(utcMs, timeZone)
  const pad = (n: number, width = 2) => String(n).padStart(width, "0")
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}`
}

export function formatTimestampInZone(zohoTimestamp: string, timeZone: string): string {
  const ms = Date.parse(zohoTimestamp)
  if (!Number.isFinite(ms)) return zohoTimestamp
  return `${formatInZone(ms, timeZone)} (${timeZone})`
}
