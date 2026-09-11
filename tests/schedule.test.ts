import test from "node:test"
import assert from "node:assert/strict"
import { scheduleSessions, sessionToTimestamps } from "../src/domain/schedule.ts"
import { resolveBatch } from "../src/domain/resolve.ts"
import { DraftInputSchema } from "../src/domain/types.ts"
import { baseConfig, metadata, draft } from "./helpers.ts"

const OPTS = {
  windowStart: "09:00",
  windowEnd: "18:00",
  defaultMinutes: 60,
  minMinutes: 15,
  maxMinutes: 480,
  granularityMinutes: 5,
}

const SESSION_FIELDS = [
  { id: "1", apiName: "cf_date_time_1", displayLabel: "Start", type: "DateTime", isCustomField: true, isMandatory: false, maxLength: null, allowedValues: [] },
  { id: "2", apiName: "cf_end_date_and_time", displayLabel: "End", type: "DateTime", isCustomField: true, isMandatory: false, maxLength: null, allowedValues: [] },
  { id: "3", apiName: "cf_percentage_of_completion", displayLabel: "Percent", type: "Percent", isCustomField: true, isMandatory: false, maxLength: null, allowedValues: [] },
]

function sessionConfig(overrides: Record<string, any> = {}) {
  return baseConfig({
    workSession: {
      enabled: true,
      windowStart: "09:00",
      windowEnd: "18:00",
      startFieldApiName: "cf_date_time_1",
      endFieldApiName: "cf_end_date_and_time",
      percentageFieldApiName: "cf_percentage_of_completion",
      percentageValue: 100,
      defaultMinutes: 60,
      minMinutes: 15,
      maxMinutes: 480,
      granularityMinutes: 5,
      ...overrides,
    },
  })
}

test("packs sessions back to back from the start of the window", () => {
  const result = scheduleSessions([90, 120, 150, 120, 45], OPTS)
  assert.equal(result.overflow, false)
  assert.equal(result.compressed, false)
  assert.deepEqual(
    result.sessions.map((s) => `${s.startLocal}-${s.endLocal}`),
    ["09:00-10:30", "10:30-12:30", "12:30-15:00", "15:00-17:00", "17:00-17:45"],
  )
})

test("sessions never overlap and never leave the window", () => {
  const result = scheduleSessions([200, 200, 200, 200], OPTS)
  let previousEnd = 9 * 60
  for (const session of result.sessions) {
    assert.equal(session.startMinutes, previousEnd, "each session starts where the last ended")
    assert.ok(session.endMinutes <= 18 * 60, "no session may end after the window")
    previousEnd = session.endMinutes
  }
})

test("compresses proportionally rather than spilling past the end of the day", () => {
  const result = scheduleSessions([300, 300, 300], OPTS) // 900 minutes into a 540 window
  assert.equal(result.compressed, true)
  assert.equal(result.overflow, false)
  const total = result.sessions.reduce((sum, s) => sum + s.durationMinutes, 0)
  assert.ok(total <= 540, `total ${total} must fit the window`)
  assert.equal(result.sessions.at(-1)!.endLocal, "18:00")
  assert.match(result.notes[0]!, /scaled down proportionally/)
})

test("reports overflow when items cannot fit even at the minimum duration", () => {
  const many = new Array(40).fill(60) // 40 x 15min minimum = 600 > 540
  const result = scheduleSessions(many, OPTS)
  assert.equal(result.overflow, true)
  assert.equal(result.sessions.length, 0)
  assert.match(result.notes[0]!, /cannot fit/)
})

test("falls back to the default duration when the model gives no estimate", () => {
  const result = scheduleSessions([null, null], OPTS)
  assert.deepEqual(
    result.sessions.map((s) => s.durationMinutes),
    [60, 60],
  )
})

test("clamps absurd estimates and rounds to the configured granularity", () => {
  const result = scheduleSessions([2, 37, 5000], OPTS)
  const durations = result.sessions.map((s) => s.durationMinutes)
  assert.equal(durations[0], 15, "below the minimum is clamped up")
  assert.equal(durations[1], 35, "rounded to 5 minutes")
  assert.ok(durations[2]! <= 480, "above the maximum is clamped down")
  for (const d of durations) assert.equal(d % 5, 0, "every duration is a multiple of the granularity")
})

test("converts a session to the UTC timestamps Zoho requires", () => {
  const [session] = scheduleSessions([90], OPTS).sessions
  // Beirut is UTC+3 in September, so 09:00-10:30 local is 06:00-07:30Z.
  const stamps = sessionToTimestamps("2026-09-10", session!, "Asia/Beirut")
  assert.deepEqual(stamps, { start: "2026-09-10T06:00:00.000Z", end: "2026-09-10T07:30:00.000Z" })
})

test("converts correctly in winter, when the offset differs", () => {
  const [session] = scheduleSessions([60], OPTS).sessions
  // Beirut is UTC+2 in January, so 09:00-10:00 local is 07:00-08:00Z.
  const stamps = sessionToTimestamps("2026-01-15", session!, "Asia/Beirut")
  assert.deepEqual(stamps, { start: "2026-01-15T07:00:00.000Z", end: "2026-01-15T08:00:00.000Z" })
})

test("writes sessions into the configured custom fields end to end", () => {
  const config = sessionConfig()
  const meta = metadata({ taskFields: SESSION_FIELDS })
  const result = resolveBatch(
    {
      workDate: "2026-09-10",
      tasks: [
        DraftInputSchema.parse(draft({ subject: "Microsoft Dashboard — client verification", estimatedMinutes: 90 })),
        DraftInputSchema.parse(draft({ subject: "Proactive — JobType data", sourceRef: "b", estimatedMinutes: 120 })),
      ],
    },
    config,
    meta,
  )

  assert.deepEqual(result.items[0]!.blockedReasons, [])
  assert.deepEqual(result.items[0]!.payload.cf, {
    cf_date_time_1: "2026-09-10T06:00:00.000Z",
    cf_end_date_and_time: "2026-09-10T07:30:00.000Z",
    cf_percentage_of_completion: "100",
  })
  assert.deepEqual(result.items[1]!.payload.cf, {
    cf_date_time_1: "2026-09-10T07:30:00.000Z",
    cf_end_date_and_time: "2026-09-10T09:30:00.000Z",
    cf_percentage_of_completion: "100",
  })
  assert.equal(result.items[0]!.session!.startLocal, "09:00")
})

test("blocks when a work-session custom field is not verified to exist", () => {
  const config = sessionConfig()
  const result = resolveBatch(
    { workDate: "2026-09-10", tasks: [DraftInputSchema.parse(draft({ estimatedMinutes: 60 }))] },
    config,
    metadata({ taskFields: [SESSION_FIELDS[0]!] }), // end field missing
  )
  assert.match(result.items[0]!.blockedReasons[0]!, /cf_end_date_and_time.*do not exist/)
  assert.ok(!result.items[0]!.payload.cf, "nothing unverified may be sent")
})

test("blocks when scheduling is enabled but no metadata has been discovered", () => {
  const result = resolveBatch(
    { workDate: "2026-09-10", tasks: [DraftInputSchema.parse(draft())] },
    sessionConfig(),
    null,
  )
  assert.match(result.items[0]!.blockedReasons[0]!, /Cannot verify the work-session custom fields/)
})

test("writes no session fields when the feature is disabled", () => {
  const result = resolveBatch(
    { workDate: "2026-09-10", tasks: [DraftInputSchema.parse(draft({ estimatedMinutes: 90 }))] },
    baseConfig(),
    metadata({ taskFields: SESSION_FIELDS }),
  )
  assert.ok(!result.items[0]!.payload.cf)
})

test("the payload hash reflects a change of session times", () => {
  const config = sessionConfig()
  const meta = metadata({ taskFields: SESSION_FIELDS })
  const build = (minutes: number) =>
    resolveBatch(
      { workDate: "2026-09-10", tasks: [DraftInputSchema.parse(draft({ estimatedMinutes: minutes }))] },
      config,
      meta,
    ).items[0]!.payloadHash

  assert.notEqual(build(60), build(120), "different sessions must produce different hashes")
  assert.equal(build(60), build(60), "the same input must be reproducible")
})
