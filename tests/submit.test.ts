import test from "node:test"
import assert from "node:assert/strict"
import { submitBatch } from "../src/service/submit.ts"
import { prepareBatch } from "../src/service/prepare.ts"
import { ZohoError } from "../src/zoho/errors.ts"
import { testApp, baseConfig, draft, FakeClient } from "./helpers.ts"
import type { App } from "../src/service/app.ts"

const CREATED = {
  id: "3000000054002",
  subject: "Auditax — Ubuntu deployment",
  status: "Completed",
  statusType: "Closed",
  webUrl: "https://desk.zoho.eu/support/x/ShowHomePage.do#Tasks/dv/3000000054002",
  createdTime: "2026-09-10T09:00:00.000Z",
}

/**
 * Reconciliation only accepts a task created inside the attempt's time window,
 * so a task that a reconciliation test should find must look freshly created.
 */
function justCreated(overrides: Record<string, unknown> = {}) {
  return { ...CREATED, createdTime: new Date().toISOString(), ...overrides }
}

async function appWith(handlers: any[], config = baseConfig()): Promise<{ app: App; client: FakeClient }> {
  const client = new FakeClient(handlers)
  const app = await testApp({ config, client })
  return { app, client }
}

function prep(app: App, drafts: any[] = [draft()]) {
  return prepareBatch(app, { workDate: "2026-09-10", tasks: drafts }, { now: Date.parse("2026-09-10T06:00:00Z") })
}

test("creates a task and verifies it by reading it back", async () => {
  const { app } = await appWith([() => CREATED, () => CREATED])
  const batch = prep(app)
  const report = await submitBatch(app, batch.batchId)

  assert.equal(report.counts.created, 1)
  const item = report.items[0]!
  assert.equal(item.state, "created")
  assert.equal(item.zohoId, CREATED.id)
  assert.equal(item.verified, true)
  assert.equal(item.webUrl, CREATED.webUrl, "the link must come from Zoho, not be constructed")
  assert.match(item.message, /verified/)
  app.store.close()
})

test("distinguishes 'created but read-back pending' from 'verified created'", async () => {
  const { app } = await appWith([
    () => CREATED,
    () => new ZohoError({ message: "read failed", category: "network" }),
  ])
  const batch = prep(app)
  const report = await submitBatch(app, batch.batchId)

  const item = report.items[0]!
  assert.equal(item.state, "created")
  assert.equal(item.zohoId, CREATED.id, "the Zoho ID must be retained even when verification fails")
  assert.equal(item.verified, false)
  assert.match(item.message, /read-back failed/)
  app.store.close()
})

test("a definitive validation rejection fails the item without creating anything", async () => {
  const { app } = await appWith([
    () =>
      new ZohoError({
        message: "Zoho rejected the data as invalid",
        category: "validation",
        status: 422,
        errorCode: "INVALID_DATA",
        fieldErrors: [{ fieldName: "/departmentId", errorType: "invalid" }],
      }),
  ])
  const batch = prep(app)
  const report = await submitBatch(app, batch.batchId)

  const item = report.items[0]!
  assert.equal(item.state, "failed")
  assert.equal(item.zohoId, null)
  assert.match(item.message, /departmentId \(invalid\)/)
  app.store.close()
})

test("a timeout after sending leaves the item uncertain and reconciles instead of replaying", async () => {
  let creates = 0
  const { app, client } = await appWith([
    () => {
      creates += 1
      return new ZohoError({ message: "Request timed out", category: "network" })
    },
    // Reconciliation search finds the task: the create had actually landed.
    () => ({ data: [justCreated()], count: 1 }),
  ])
  const batch = prep(app)
  const report = await submitBatch(app, batch.batchId)

  assert.equal(creates, 1, "a write must never be retried automatically")
  const searchCall = client.calls.find((c) => c.pathname === "/tasks/search")
  assert.ok(searchCall, "reconciliation must search rather than re-create")

  const item = report.items[0]!
  assert.equal(item.state, "created")
  assert.equal(item.zohoId, CREATED.id)
  assert.match(item.message, /had succeeded despite the failed response/)
  app.store.close()
})

test("a server error whose task cannot be found stays uncertain, not failed", async () => {
  const { app } = await appWith([
    () => new ZohoError({ message: "Internal error", category: "server", status: 500 }),
    () => ({ data: [], count: 0 }),
  ])
  const batch = prep(app)
  const report = await submitBatch(app, batch.batchId)

  const item = report.items[0]!
  assert.equal(item.state, "uncertain", "an unfound task after a 5xx must not be declared failed")
  assert.match(item.message, /confirm in Zoho before resubmitting/)
  app.store.close()
})

test("ambiguous reconciliation refuses to pick a candidate", async () => {
  const { app } = await appWith([
    () => new ZohoError({ message: "timeout", category: "network" }),
    () => ({ data: [justCreated(), justCreated({ id: "999" })], count: 2 }),
  ])
  const batch = prep(app)
  const report = await submitBatch(app, batch.batchId)

  const item = report.items[0]!
  assert.equal(item.state, "uncertain")
  assert.equal(item.zohoId, null, "must not guess which candidate is ours")
  assert.match(item.message, /2 candidate tasks/)
  app.store.close()
})

test("resubmitting a created batch returns saved results without creating again", async () => {
  const { app, client } = await appWith([() => CREATED, () => CREATED])
  const batch = prep(app)
  await submitBatch(app, batch.batchId)
  const callsAfterFirst = client.calls.length

  const second = await submitBatch(app, batch.batchId)
  assert.equal(client.calls.length, callsAfterFirst, "no further Zoho calls may be made")
  assert.equal(second.items[0]!.state, "created")
  assert.equal(second.items[0]!.zohoId, CREATED.id)
  assert.match(second.items[0]!.message, /Already created/)
  app.store.close()
})

test("a systemic auth failure stops the batch instead of hammering every item", async () => {
  const { app, client } = await appWith([
    () =>
      new ZohoError({
        message: "The OAuth token lacks the required scope",
        category: "config",
        status: 403,
        errorCode: "SCOPE_MISMATCH",
      }),
  ])
  const batch = prep(app, [draft(), draft({ subject: "Second task", sourceRef: "second" })])
  const report = await submitBatch(app, batch.batchId)

  assert.ok(report.stopped, "the batch must halt")
  assert.equal(report.stopped!.category, "config")
  assert.equal(client.calls.length, 1, "only the first item may be attempted")
  assert.equal(report.items[1]!.message, "Not attempted: the batch stopped earlier.")
  // The unsent item must remain submittable later, not stuck mid-flight.
  assert.equal(app.store.getItem(report.items[1]!.itemId)!.state, "ready")
  app.store.close()
})

test("partial success retains created items and identifies failures individually", async () => {
  const { app } = await appWith([
    () => CREATED,
    () => CREATED,
    () =>
      new ZohoError({
        message: "invalid",
        category: "validation",
        status: 422,
        errorCode: "INVALID_DATA",
      }),
  ])
  const batch = prep(app, [draft(), draft({ subject: "Second task", sourceRef: "second" })])
  const report = await submitBatch(app, batch.batchId)

  assert.equal(report.counts.created, 1)
  assert.equal(report.counts.failed, 1)
  assert.equal(report.items[0]!.state, "created")
  assert.equal(report.items[1]!.state, "failed")
  app.store.close()
})

test("blocked items are reported without being sent", async () => {
  const { app, client } = await appWith([])
  const batch = prep(app, [draft({ ownerId: "9999" })])
  const report = await submitBatch(app, batch.batchId)

  assert.equal(client.calls.length, 0)
  assert.equal(report.items[0]!.state, "blocked")
  assert.match(report.items[0]!.message, /not an active agent/)
  app.store.close()
})

test("reports when Zoho did not close a task created as completed", async () => {
  const openTask = { ...CREATED, status: "Not Started", statusType: "Open" }
  const { app, client } = await appWith([() => CREATED, () => openTask])
  const batch = prep(app)
  const report = await submitBatch(app, batch.batchId)

  assert.equal(report.items[0]!.state, "created")
  assert.match(report.items[0]!.message, /did not close it on create/)
  assert.ok(report.notes.some((n) => /patchIfNotClosed/.test(n)))
  assert.ok(
    !client.calls.some((c) => c.opts.method === "PATCH"),
    "a second write must not happen unless explicitly enabled",
  )
  app.store.close()
})

test("issues a follow-up status update only when explicitly enabled", async () => {
  const openTask = { ...CREATED, status: "Not Started", statusType: "Open" }
  const config = baseConfig({ statusFollowUp: { patchIfNotClosed: true } })
  const { app, client } = await appWith([() => CREATED, () => openTask, () => CREATED], config)
  const batch = prep(app)
  const report = await submitBatch(app, batch.batchId)

  const patch = client.calls.find((c) => c.opts.method === "PATCH")
  assert.ok(patch, "the follow-up update must be issued")
  assert.match(report.items[0]!.message, /follow-up update closed it/)
  app.store.close()
})
