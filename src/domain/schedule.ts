import { parseTimeParts, parseDateParts, resolveWallClock, toZohoTimestamp } from "./time.ts"

/**
 * Work-session scheduling.
 *
 * The model estimates how long each item plausibly took; this allocates the
 * actual clock times. Keeping the arithmetic here rather than in the model
 * means sessions can never overlap, never escape the configured window, and
 * never change when the same batch is prepared twice.
 *
 * Durations are estimates, not measurements. That is a deliberate, configured
 * policy - see plan.md section 24.
 */

export type ScheduleOptions = {
  /** Local window bounds as "HH:MM". */
  windowStart: string
  windowEnd: string
  defaultMinutes: number
  minMinutes: number
  maxMinutes: number
  granularityMinutes: number
}

export type ScheduledSession = {
  /** Minutes from local midnight. */
  startMinutes: number
  endMinutes: number
  durationMinutes: number
  startLocal: string
  endLocal: string
}

export type ScheduleResult = {
  sessions: ScheduledSession[]
  /** Set when estimates were scaled down to fit the window. */
  compressed: boolean
  /** Set when the items cannot fit even at the minimum duration each. */
  overflow: boolean
  notes: string[]
}

function toMinutes(hhmm: string): number {
  const { hour, minute } = parseTimeParts(hhmm)
  return hour * 60 + minute
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

function roundTo(value: number, granularity: number): number {
  if (granularity <= 1) return Math.round(value)
  return Math.round(value / granularity) * granularity
}

/**
 * Pack sessions back to back from the start of the window.
 *
 * If the estimates exceed the window they are scaled proportionally rather than
 * spilling past the end of the day. If even the minimum durations do not fit,
 * this reports overflow instead of silently producing a nonsensical day.
 */
export function scheduleSessions(estimates: Array<number | null>, opts: ScheduleOptions): ScheduleResult {
  const notes: string[] = []
  const windowStart = toMinutes(opts.windowStart)
  const windowEnd = toMinutes(opts.windowEnd)
  const windowMinutes = windowEnd - windowStart

  if (windowMinutes <= 0) {
    return {
      sessions: [],
      compressed: false,
      overflow: true,
      notes: [`The configured work window ${opts.windowStart}-${opts.windowEnd} is empty or inverted.`],
    }
  }
  if (!estimates.length) {
    return { sessions: [], compressed: false, overflow: false, notes }
  }

  const clamp = (value: number) =>
    Math.min(opts.maxMinutes, Math.max(opts.minMinutes, roundTo(value, opts.granularityMinutes)))

  let durations = estimates.map((estimate) => clamp(estimate ?? opts.defaultMinutes))

  const minimumTotal = opts.minMinutes * durations.length
  if (minimumTotal > windowMinutes) {
    return {
      sessions: [],
      compressed: false,
      overflow: true,
      notes: [
        `${durations.length} tasks cannot fit between ${opts.windowStart} and ${opts.windowEnd}, ` +
          `even at the ${opts.minMinutes}-minute minimum each. Split the day across two work dates, ` +
          `or widen the window.`,
      ],
    }
  }

  let total = durations.reduce((sum, value) => sum + value, 0)
  let compressed = false

  if (total > windowMinutes) {
    compressed = true
    const factor = windowMinutes / total
    durations = durations.map((value) => clamp(value * factor))

    // Rounding and the minimum clamp can push the total back over the window,
    // so trim the longest sessions until it fits exactly.
    total = durations.reduce((sum, value) => sum + value, 0)
    while (total > windowMinutes) {
      let longest = 0
      for (let i = 1; i < durations.length; i++) {
        if (durations[i]! > durations[longest]!) longest = i
      }
      if (durations[longest]! <= opts.minMinutes) break
      durations[longest] = durations[longest]! - opts.granularityMinutes
      total -= opts.granularityMinutes
    }

    notes.push(
      `Estimated durations totalled more than the ${opts.windowStart}-${opts.windowEnd} window, ` +
        `so they were scaled down proportionally to fit.`,
    )
  }

  const sessions: ScheduledSession[] = []
  let cursor = windowStart
  for (const duration of durations) {
    const startMinutes = cursor
    const endMinutes = Math.min(windowEnd, cursor + duration)
    sessions.push({
      startMinutes,
      endMinutes,
      durationMinutes: endMinutes - startMinutes,
      startLocal: formatMinutes(startMinutes),
      endLocal: formatMinutes(endMinutes),
    })
    cursor = endMinutes
  }

  return { sessions, compressed, overflow: false, notes }
}

export type SessionTimestamps = {
  start: string
  end: string
}

/**
 * Convert a scheduled local session on a given date into the UTC timestamps
 * Zoho requires. Returns null if the local time is invalid in this zone, which
 * only happens across a DST transition.
 */
export function sessionToTimestamps(
  workDate: string,
  session: ScheduledSession,
  timeZone: string,
): SessionTimestamps | null {
  const { year, month, day } = parseDateParts(workDate)

  const at = (minutes: number) => {
    const resolved = resolveWallClock(
      { year, month, day, hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0 },
      timeZone,
    )
    return resolved.kind === "ok" ? resolved.utcMs : null
  }

  const startMs = at(session.startMinutes)
  const endMs = at(session.endMinutes)
  if (startMs === null || endMs === null) return null

  return { start: toZohoTimestamp(startMs), end: toZohoTimestamp(endMs) }
}
