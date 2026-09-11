#!/usr/bin/env node
/**
 * Verifies the core works in whichever runtime is executing it.
 *
 * This matters because OpenCode executes custom tools inside its embedded Bun
 * runtime, while the CLI and test suite run under Node. The SQLite driver
 * differs between the two, so the state layer must be exercised in both.
 *
 *   node scripts/runtime-check.ts          # Node path (node:sqlite)
 *   npx bun scripts/runtime-check.ts       # Bun path (bun:sqlite)
 */
import assert from "node:assert/strict"
import { Store } from "../src/state/store.ts"
import { resolveBatch } from "../src/domain/resolve.ts"
import { DraftInputSchema } from "../src/domain/types.ts"
import { parseConfig } from "../src/config/config.ts"

const isBun = typeof (globalThis as any).Bun !== "undefined"
const runtime = isBun ? `Bun ${(globalThis as any).Bun.version}` : `Node ${process.version}`

const config = parseConfig({
  schemaVersion: 1,
  region: "eu",
  orgId: "700000001",
  timezone: "Asia/Beirut",
  defaults: { departmentId: "1000", ownerId: "2000", priority: "Normal" },
  statusMap: { completed_work_session: "Completed", in_progress: "In Progress", planned: "Not Started" },
  workDate: { mode: "dueDate", customFieldApiName: null },
  aliases: {},
  statusFollowUp: { patchIfNotClosed: false },
  submissionMode: "preview",
  limits: { maxBatchSize: 25, requestTimeoutMs: 5000, maxRetries: 2, duplicateWindowDays: 7 },
  retentionDays: 30,
})

const store = await Store.open(":memory:")

const resolved = resolveBatch(
  {
    workDate: "2026-09-10",
    tasks: [
      DraftInputSchema.parse({
        sourceRef: "Auditax: installed Ubuntu",
        subject: "Auditax — Ubuntu deployment",
        description: "Installed Ubuntu for Auditax.",
        statusIntent: "completed_work_session",
      }),
    ],
  },
  config,
  null,
)

store.createBatch(
  {
    id: "runtime-check",
    createdAt: new Date().toISOString(),
    workDate: resolved.workDate,
    timezone: config.timezone,
    mode: "preview",
    schemaVersion: 1,
    sourceText: null,
  },
  resolved.items,
  { duplicateWindowDays: 7 },
)

const item = store.listItems("runtime-check")[0]!
assert.equal(item.state, "ready")
assert.equal(JSON.parse(item.payloadJson).dueDate, "2026-09-10T09:00:00.000Z", "timezone conversion")
assert.equal(store.claimItem(item.id), true, "first claim succeeds")
assert.equal(store.claimItem(item.id), false, "second claim is refused")

const stale = store.recoverStaleSubmitting(0)
assert.equal(stale.length, 1)
assert.equal(store.getItem(item.id)!.state, "uncertain", "an interrupted claim never returns to ready")

store.close()
console.log(`runtime check passed on ${runtime} (${isBun ? "bun:sqlite" : "node:sqlite"})`)
