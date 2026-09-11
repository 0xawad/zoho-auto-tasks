import test from "node:test"
import assert from "node:assert/strict"
import { Store } from "../src/state/store.ts"
import { resolveBatch } from "../src/domain/resolve.ts"
import { DraftInputSchema, type ResolvedItem } from "../src/domain/types.ts"
import { baseConfig, metadata, draft } from "./helpers.ts"

async function seed(
  drafts: any[] = [draft()],
  opts: { duplicateWindowDays?: number } = {},
): Promise<{ store: Store; batchId: string; items: ResolvedItem[] }> {
  const store = await Store.open(":memory:")
  const resolved = resolveBatch(
    { workDate: "2026-09-10", tasks: drafts.map((d) => DraftInputSchema.parse(d)) },
    baseConfig(),
    metadata(),
  )
  const batchId = "batch-1"
  store.createBatch(
    {
      id: batchId,
      createdAt: new Date().toISOString(),
      workDate: resolved.workDate,
      timezone: "Asia/Beirut",
      mode: "preview",
      schemaVersion: 1,
      sourceText: "raw summary",
    },
    resolved.items,
    { duplicateWindowDays: opts.duplicateWindowDays ?? 7 },
  )
  return { store, batchId, items: resolved.items }
}

test("persists items as ready before anything is sent", async () => {
  const { store, batchId } = await seed()
  const items = store.listItems(batchId)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.state, "ready")
  store.close()
})

test("persists a failing draft as blocked, never ready", async () => {
  const { store, batchId } = await seed([draft({ ownerId: "9999" })])
  assert.equal(store.listItems(batchId)[0]!.state, "blocked")
  store.close()
})

test("only one caller can claim an item for submission", async () => {
  const { store, batchId } = await seed()
  const id = store.listItems(batchId)[0]!.id
  assert.equal(store.claimItem(id), true)
  assert.equal(store.claimItem(id), false, "a second claim must fail")
  assert.equal(store.getItem(id)!.state, "submitting")
  store.close()
})

test("a claimed item cannot be claimed again after being created", async () => {
  const { store, batchId } = await seed()
  const id = store.listItems(batchId)[0]!.id
  store.claimItem(id)
  store.recordCreated(id, "3000000054002", "https://desk.zoho.eu/…", true)
  assert.equal(store.claimItem(id), false)
  assert.equal(store.getItem(id)!.state, "created")
  store.close()
})

test("an interrupted submission becomes uncertain, never ready", async () => {
  const { store, batchId } = await seed()
  const id = store.listItems(batchId)[0]!.id
  store.claimItem(id)

  // Simulate a crash: the item is stuck in 'submitting' with no outcome.
  const recovered = store.recoverStaleSubmitting(0)
  assert.equal(recovered.length, 1)
  const after = store.getItem(id)!
  assert.equal(after.state, "uncertain", "a stale claim must not become ready again")
  assert.match((after.error as any).message, /may or may not exist/)
  store.close()
})

test("flags a same-day equivalent task created earlier as a likely duplicate", async () => {
  const first = await seed()
  const id = first.store.listItems(first.batchId)[0]!.id
  first.store.claimItem(id)
  first.store.recordCreated(id, "111", null, true)

  // A second batch on the same day with reworded but equivalent content.
  const resolved = resolveBatch(
    {
      workDate: "2026-09-10",
      tasks: [DraftInputSchema.parse(draft({ subject: "auditax: ubuntu deployment" }))],
    },
    baseConfig(),
    metadata(),
  )
  first.store.createBatch(
    {
      id: "batch-2",
      createdAt: new Date().toISOString(),
      workDate: "2026-09-10",
      timezone: "Asia/Beirut",
      mode: "preview",
      schemaVersion: 1,
      sourceText: null,
    },
    resolved.items,
    { duplicateWindowDays: 7 },
  )

  const second = first.store.listItems("batch-2")[0]!
  assert.equal(second.state, "duplicate_skipped")
  assert.match(second.blockedReasons[0]!, /already created/)

  // The user can confirm it is genuinely distinct work.
  assert.equal(first.store.confirmDistinct(second.id), true)
  assert.equal(first.store.getItem(second.id)!.state, "ready")
  first.store.close()
})

test("does not suppress the same work reported on a different day", async () => {
  const first = await seed()
  const id = first.store.listItems(first.batchId)[0]!.id
  first.store.claimItem(id)
  first.store.recordCreated(id, "111", null, true)

  const resolved = resolveBatch(
    { workDate: "2026-09-11", tasks: [DraftInputSchema.parse(draft())] },
    baseConfig(),
    metadata(),
  )
  first.store.createBatch(
    {
      id: "batch-3",
      createdAt: new Date().toISOString(),
      workDate: "2026-09-11",
      timezone: "Asia/Beirut",
      mode: "preview",
      schemaVersion: 1,
      sourceText: null,
    },
    resolved.items,
    { duplicateWindowDays: 7 },
  )
  assert.equal(first.store.listItems("batch-3")[0]!.state, "ready")
  first.store.close()
})

test("refuses to record two items against the same Zoho task ID", async () => {
  const { store, batchId } = await seed([draft(), draft({ subject: "Different work" })])
  const items = store.listItems(batchId)
  store.claimItem(items[0]!.id)
  store.recordCreated(items[0]!.id, "999", null, true)
  store.claimItem(items[1]!.id)
  assert.throws(() => store.recordCreated(items[1]!.id, "999", null, true), /UNIQUE|constraint/i)
  store.close()
})

test("retention purges raw text but preserves duplicate protection", async () => {
  const { store, batchId } = await seed()
  const id = store.listItems(batchId)[0]!.id
  store.claimItem(id)
  store.recordCreated(id, "555", null, true)
  const fingerprintBefore = store.getItem(id)!.fingerprint

  store.purgeOldRawText(-1) // treat everything as older than the cutoff

  const after = store.getItem(id)!
  assert.equal(after.sourceRef, "<purged>")
  assert.equal(after.description, "")
  assert.equal(after.fingerprint, fingerprintBefore, "fingerprints must survive purging")
  assert.equal(after.zohoId, "555", "Zoho IDs must survive purging")
  assert.equal(store.getBatch(batchId)!.sourceText, null)
  store.close()
})

test("records attempts as a bounded ledger", async () => {
  const { store, batchId } = await seed()
  const id = store.listItems(batchId)[0]!.id
  for (let i = 0; i < 25; i++) {
    store.appendAttempt(id, {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outcome: `attempt-${i}`,
    })
  }
  const attempts = store.getItem(id)!.attempts
  assert.equal(attempts.length, 20)
  assert.equal(attempts[19]!.outcome, "attempt-24")
  store.close()
})
