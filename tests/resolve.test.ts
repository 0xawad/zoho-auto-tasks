import test from "node:test"
import assert from "node:assert/strict"
import { resolveBatch, DraftError, LIMITS } from "../src/domain/resolve.ts"
import { DraftInputSchema } from "../src/domain/types.ts"
import { contentFingerprint, normalizeSubject } from "../src/domain/fingerprint.ts"
import { baseConfig, metadata, draft } from "./helpers.ts"

function build(tasks: any[], config = baseConfig(), meta: any = metadata()) {
  return resolveBatch(
    { workDate: "2026-09-10", tasks: tasks.map((t) => DraftInputSchema.parse(t)) },
    config,
    meta,
  )
}

test("builds a payload containing only verified Zoho fields", () => {
  const { items } = build([draft()])
  assert.equal(items.length, 1)
  assert.deepEqual(items[0]!.payload, {
    departmentId: "1000",
    subject: "Auditax — Ubuntu deployment",
    description: "Installed Ubuntu for Auditax.",
    ownerId: "2000",
    status: "Completed",
    priority: "Normal",
  })
  assert.deepEqual(items[0]!.blockedReasons, [])
})

test("never sends a start or end time, because Zoho tasks have no such writable field", () => {
  const { items } = build([draft()])
  const keys = Object.keys(items[0]!.payload)
  assert.ok(!keys.includes("startTime"))
  assert.ok(!keys.includes("endTime"))
  assert.ok(!keys.includes("startAt"))
})

test("rejects a draft carrying an unknown field", () => {
  assert.throws(() => DraftInputSchema.parse({ ...draft(), severity: "critical" }), /Unrecognized key/)
})

test("rejects an over-length subject at the tool boundary", () => {
  assert.throws(() => DraftInputSchema.parse(draft({ subject: "x".repeat(LIMITS.subject + 1) })), /too_big|300/)
})

test("blocks an over-length subject in the domain layer too, rather than truncating", () => {
  // Defence in depth: even if a draft reaches resolve without schema validation,
  // it is blocked locally instead of being sent and rejected by Zoho.
  const result = resolveBatch(
    { workDate: "2026-09-10", tasks: [{ ...draft(), subject: "x".repeat(LIMITS.subject + 1) }] as any },
    baseConfig(),
    metadata(),
  )
  assert.equal(result.items[0]!.blockedReasons.length, 1)
  assert.match(result.items[0]!.blockedReasons[0]!, /Zoho allows 300/)
})

test("blocks a status the portal does not accept", () => {
  const config = baseConfig({
    statusMap: { completed_work_session: "Done", in_progress: "In Progress", planned: "Not Started" },
  })
  const { items } = build([draft()], config)
  assert.match(items[0]!.blockedReasons[0]!, /is not a value this Zoho portal accepts/)
  assert.ok(!("status" in items[0]!.payload))
})

test("blocks a priority the portal does not accept", () => {
  const { items } = build([draft({ priority: "Urgent" })])
  assert.match(items[0]!.blockedReasons[0]!, /Priority "Urgent" is not a value/)
})

test("blocks an owner who is not an active agent", () => {
  const { items } = build([draft({ ownerId: "9999" })])
  assert.match(items[0]!.blockedReasons[0]!, /not an active agent/)
})

test("blocks a department that does not exist", () => {
  const { items } = build([draft({ departmentId: "9999" })])
  assert.match(items[0]!.blockedReasons[0]!, /does not exist in this Zoho portal/)
})

test("keeps an unknown client in the wording without inventing an association", () => {
  const { items } = build([draft({ clientLabel: "Unknown Corp" })])
  assert.deepEqual(items[0]!.blockedReasons, [])
  assert.ok(!("contactId" in items[0]!.payload))
  assert.ok(!("ticketId" in items[0]!.payload))
})

test("resolves a configured client alias to its contact ID", () => {
  const config = baseConfig({
    aliases: { Auditax: { contactId: "5555", ticketId: null, label: null } },
  })
  const { items } = build([draft()], config)
  assert.equal(items[0]!.payload.contactId, "5555")
})

test("alias matching is case insensitive", () => {
  const config = baseConfig({ aliases: { auditax: { contactId: "5555", ticketId: null, label: null } } })
  const { items } = build([draft({ clientLabel: "AUDITAX" })], config)
  assert.equal(items[0]!.payload.contactId, "5555")
})

test("blocks the association when a client matches multiple aliases", () => {
  const config = baseConfig({
    aliases: {
      Auditax: { contactId: "1", ticketId: null, label: null },
      " auditax ": { contactId: "2", ticketId: null, label: null },
    },
  })
  const { items } = build([draft()], config)
  assert.match(items[0]!.blockedReasons[0]!, /matches 2 configured aliases/)
  assert.ok(!("contactId" in items[0]!.payload))
})

test("maps the work date onto dueDate only when configured to", () => {
  const none = build([draft()])
  assert.ok(!("dueDate" in none.items[0]!.payload))

  const config = baseConfig({ workDate: { mode: "dueDate", customFieldApiName: null } })
  const { items } = build([draft()], config)
  assert.equal(items[0]!.payload.dueDate, "2026-09-10T09:00:00.000Z")
})

test("blocks a work-date custom field that cannot be verified", () => {
  const config = baseConfig({ workDate: { mode: "customField", customFieldApiName: "cf_work_date" } })
  const { items } = build([draft()], config, null)
  assert.match(items[0]!.blockedReasons[0]!, /Cannot verify that custom field/)
  assert.ok(!("cf" in items[0]!.payload), "an unverified custom field must never be sent")
})

test("blocks a work-date custom field that does not exist on tasks", () => {
  const config = baseConfig({ workDate: { mode: "customField", customFieldApiName: "cf_work_date" } })
  const meta = metadata({
    taskFields: [
      {
        id: "1",
        apiName: "cf_something_else",
        displayLabel: "Other",
        type: "Text",
        isCustomField: true,
        isMandatory: false,
        maxLength: null,
        allowedValues: [],
      },
    ],
  })
  const { items } = build([draft()], config, meta)
  assert.match(items[0]!.blockedReasons[0]!, /does not exist on tasks/)
})

test("writes the work date into a custom field that does exist", () => {
  const config = baseConfig({ workDate: { mode: "customField", customFieldApiName: "cf_work_date" } })
  const meta = metadata({
    taskFields: [
      {
        id: "1",
        apiName: "cf_work_date",
        displayLabel: "Work Date",
        type: "Date",
        isCustomField: true,
        isMandatory: false,
        maxLength: null,
        allowedValues: [],
      },
    ],
  })
  const { items } = build([draft()], config, meta)
  assert.deepEqual(items[0]!.payload.cf, { cf_work_date: "2026-09-10" })
})

test("blocks when the portal marks a field mandatory that nothing supplies", () => {
  const meta = metadata({ mandatoryFieldApiNames: ["category"] })
  const { items } = build([draft()], baseConfig(), meta)
  assert.match(items[0]!.blockedReasons[0]!, /marks "category" as mandatory/)
})

test("validates without metadata, deferring portal-specific checks", () => {
  const { items } = build([draft({ priority: "Whatever" })], baseConfig(), null)
  assert.deepEqual(items[0]!.blockedReasons, [])
  assert.equal(items[0]!.payload.priority, "Whatever")
})

test("resolves relative work dates once, at preparation", () => {
  const now = Date.parse("2026-09-10T05:00:00.000Z")
  const result = resolveBatch(
    { workDate: "yesterday", tasks: [DraftInputSchema.parse(draft())] },
    baseConfig(),
    metadata(),
    { now },
  )
  assert.equal(result.workDate, "2026-09-09")
})

test("refuses an uninterpretable work date", () => {
  assert.throws(
    () => resolveBatch({ workDate: "sometime last week", tasks: [DraftInputSchema.parse(draft())] }, baseConfig(), null),
    DraftError,
  )
})

test("refuses a batch larger than the configured maximum", () => {
  const config = baseConfig({ limits: { maxBatchSize: 2, requestTimeoutMs: 5000, maxRetries: 2, duplicateWindowDays: 7 } })
  assert.throws(() => build([draft(), draft(), draft()], config), /above the configured maximum/)
})

test("fingerprints ignore wording nuance but respect the work date", () => {
  const base = { orgId: "1", departmentId: "1000", ownerId: "2000", workDate: "2026-09-10" }
  const a = contentFingerprint({ ...base, subject: "Auditax — Ubuntu deployment" })
  const b = contentFingerprint({ ...base, subject: "auditax: ubuntu deployment!" })
  const c = contentFingerprint({ ...base, workDate: "2026-09-11", subject: "Auditax — Ubuntu deployment" })
  assert.equal(a, b, "reworded same-day work should collide")
  assert.notEqual(a, c, "the same work on another day must not be suppressed")
  assert.equal(normalizeSubject("Café — Ubuntu!"), "cafe ubuntu")
})

test("blocks placeholder IDs left over from the config template", () => {
  const config = baseConfig({
    defaults: { departmentId: "REPLACE_WITH_DEPARTMENT_ID", ownerId: "REPLACE_WITH_AGENT_ID", priority: "Normal" },
  })
  const { items } = build([draft()], config, null)
  assert.equal(items[0]!.blockedReasons.length, 2)
  assert.match(items[0]!.blockedReasons[0]!, /not a numeric Zoho ID/)
  assert.match(items[0]!.blockedReasons[1]!, /not a numeric Zoho agent ID/)
})
