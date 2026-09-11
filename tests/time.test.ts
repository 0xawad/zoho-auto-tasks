import test from "node:test"
import assert from "node:assert/strict"
import {
  resolveWallClock,
  todayInZone,
  resolveRelativeDate,
  dateToZohoTimestamp,
  toZohoTimestamp,
  isZohoTimestamp,
  parseDateParts,
  addDays,
  formatTimestampInZone,
} from "../src/domain/time.ts"

const BEIRUT = "Asia/Beirut"

test("converts a normal Beirut wall-clock time to UTC", () => {
  // 2026-09-10 12:00 Beirut is UTC+3 (summer time) => 09:00Z
  const resolved = resolveWallClock(
    { year: 2026, month: 9, day: 10, hour: 12, minute: 0, second: 0 },
    BEIRUT,
  )
  assert.equal(resolved.kind, "ok")
  assert.equal(toZohoTimestamp((resolved as any).utcMs), "2026-09-10T09:00:00.000Z")
})

test("converts a winter Beirut wall-clock time to UTC", () => {
  // 2026-01-15 12:00 Beirut is UTC+2 => 10:00Z
  const resolved = resolveWallClock(
    { year: 2026, month: 1, day: 15, hour: 12, minute: 0, second: 0 },
    BEIRUT,
  )
  assert.equal(resolved.kind, "ok")
  assert.equal(toZohoTimestamp((resolved as any).utcMs), "2026-01-15T10:00:00.000Z")
})

test("rejects a local time that does not exist in the DST gap", () => {
  // Beirut springs forward at 00:00 on the last Sunday of March: 2026-03-29.
  // 00:30 local never happens that day.
  const resolved = resolveWallClock(
    { year: 2026, month: 3, day: 29, hour: 0, minute: 30, second: 0 },
    BEIRUT,
  )
  assert.equal(resolved.kind, "nonexistent")
})

test("flags a repeated local time at the autumn transition", () => {
  // Beirut falls back at 00:00 on the last Sunday of October: 2026-10-25.
  // 23:30 on the 24th is unaffected; 00:30 is not reached, but 23:xx repeats.
  const resolved = resolveWallClock(
    { year: 2026, month: 10, day: 24, hour: 23, minute: 30, second: 0 },
    BEIRUT,
  )
  assert.equal(resolved.kind, "ambiguous")
  assert.equal((resolved as any).options.length, 2)
})

test("date markers use local noon so they can never fall in a DST gap", () => {
  // Midnight on this date does not exist in Beirut; noon does.
  assert.equal(dateToZohoTimestamp("2026-03-29", BEIRUT), "2026-03-29T09:00:00.000Z")
})

test("resolves relative dates in the configured zone", () => {
  // 2026-01-01T00:30:00Z is already 02:30 on 1 January in Beirut.
  const now = Date.parse("2026-01-01T00:30:00.000Z")
  assert.equal(todayInZone(BEIRUT, now), "2026-01-01")
  assert.equal(resolveRelativeDate("today", BEIRUT, now), "2026-01-01")
  assert.equal(resolveRelativeDate("yesterday", BEIRUT, now), "2025-12-31")
  assert.equal(resolveRelativeDate("2026-05-04", BEIRUT, now), "2026-05-04")
  assert.equal(resolveRelativeDate("last tuesday", BEIRUT, now), null)
})

test("late-evening UTC is already the next day in Beirut", () => {
  // 2026-06-30T22:00Z is 01:00 on 1 July in Beirut (UTC+3).
  const now = Date.parse("2026-06-30T22:00:00.000Z")
  assert.equal(todayInZone(BEIRUT, now), "2026-07-01")
})

test("rejects impossible calendar dates instead of rolling them over", () => {
  assert.throws(() => parseDateParts("2026-02-30"), /not a valid calendar date/)
  assert.throws(() => parseDateParts("10-09-2026"), /YYYY-MM-DD/)
  assert.equal(addDays("2026-03-01", -1), "2026-02-28")
})

test("emits and recognises Zoho's timestamp format", () => {
  assert.ok(isZohoTimestamp("2026-07-21T16:16:16.000Z"))
  assert.ok(!isZohoTimestamp("2026-07-21T16:16:16+03:00"), "offsets must be rejected")
  assert.ok(!isZohoTimestamp("2026-07-21 16:16:16Z"))
})

test("renders timestamps back in the user's zone", () => {
  assert.equal(formatTimestampInZone("2026-09-10T09:00:00.000Z", BEIRUT), "2026-09-10 12:00 (Asia/Beirut)")
})
