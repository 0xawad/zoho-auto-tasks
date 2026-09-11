import { assertSubmitReady } from "../config/config.ts"
import { ZohoError } from "../zoho/errors.ts"
import { createTask, getTask, updateTaskStatus, type TaskCreatePayload } from "../zoho/tasks.ts"
import type { ItemRecord, ItemState } from "../domain/types.ts"
import type { App } from "./app.ts"
import { reconcileItem } from "./reconcile.ts"

export type ItemResult = {
  itemId: string
  seq: number
  subject: string
  state: ItemState
  zohoId: string | null
  webUrl: string | null
  /** True only when the task was read back from Zoho after creation. */
  verified: boolean
  message: string
}

export type SubmitReport = {
  batchId: string
  workDate: string
  timezone: string
  counts: Record<string, number>
  items: ItemResult[]
  /** Set when the batch was halted before processing every item. */
  stopped: { category: string; message: string } | null
  notes: string[]
}

/**
 * Sequential by design. A personal daily batch is a handful of items, Zoho
 * charges one credit per create, and concurrency buys nothing but a harder
 * failure model.
 */
export async function submitBatch(app: App, batchId: string): Promise<SubmitReport> {
  assertSubmitReady(app.config)
  if (!app.client) {
    throw new Error("No Zoho credentials are configured, so nothing can be submitted.")
  }

  const batch = app.store.getBatch(batchId)
  if (!batch) throw new Error(`No batch found with ID ${batchId}.`)

  const notes: string[] = []
  const recovered = app.store.recoverStaleSubmitting()
  if (recovered.length) {
    notes.push(
      `${recovered.length} item(s) were left mid-submission by an earlier interrupted run and are now ` +
        `marked uncertain. Reconcile them before retrying.`,
    )
  }

  const results: ItemResult[] = []
  let stopped: SubmitReport["stopped"] = null

  for (const item of app.store.listItems(batchId)) {
    if (stopped) {
      results.push(describe(item, "Not attempted: the batch stopped earlier."))
      continue
    }
    if (item.state !== "ready") {
      results.push(describe(item, explainNonReady(item)))
      continue
    }
    if (!app.store.claimItem(item.id)) {
      const current = app.store.getItem(item.id)!
      results.push(describe(current, "Another submission already claimed this item."))
      continue
    }

    const startedAt = new Date().toISOString()
    try {
      const payload = JSON.parse(item.payloadJson) as TaskCreatePayload
      const created = await createTask(app.client, payload)

      // Persist the Zoho ID immediately; everything after this point is
      // verification, and must never be able to lose the ID.
      app.store.recordCreated(item.id, created.id, created.webUrl, false)
      app.store.appendAttempt(item.id, {
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: "created",
      })

      const verification = await verify(app, item, created.id)
      results.push({
        itemId: item.id,
        seq: item.seq,
        subject: item.subject,
        state: "created",
        zohoId: created.id,
        webUrl: created.webUrl ?? verification.webUrl,
        verified: verification.verified,
        message: verification.message,
      })
      if (verification.note) notes.push(verification.note)
    } catch (err) {
      const finishedAt = new Date().toISOString()
      if (!(err instanceof ZohoError)) {
        app.store.setState(item.id, "uncertain", {
          category: "unexpected",
          message: "An unexpected local error occurred after the request was issued.",
        })
        app.store.appendAttempt(item.id, { startedAt, finishedAt, outcome: "uncertain" })
        results.push({
          itemId: item.id,
          seq: item.seq,
          subject: item.subject,
          state: "uncertain",
          zohoId: null,
          webUrl: null,
          verified: false,
          message: "An unexpected error occurred; the outcome in Zoho is unknown. Reconcile this item.",
        })
        continue
      }

      app.store.appendAttempt(item.id, {
        startedAt,
        finishedAt,
        outcome: err.writeOutcomeUnknown ? "uncertain" : "failed",
        category: err.category,
        message: err.message,
      })

      if (err.writeOutcomeUnknown) {
        app.store.setState(item.id, "uncertain", err.toSafeJSON())
        const current = app.store.getItem(item.id)!
        const outcome = await reconcileItem(app.client, app.store, current)
        const after = app.store.getItem(item.id)!
        results.push({
          itemId: item.id,
          seq: item.seq,
          subject: item.subject,
          state: after.state,
          zohoId: after.zohoId,
          webUrl: after.webUrl,
          verified: after.verified,
          message: `${err.message} ${outcome.message}`,
        })
      } else if (err.stopsBatch) {
        // Do not leave the claim dangling: this item was never sent successfully
        // and the failure is systemic, not item-specific.
        app.store.releaseClaim(item.id)
        stopped = { category: err.category, message: err.message }
        results.push(describe(app.store.getItem(item.id)!, `Not created: ${err.message}`))
      } else {
        app.store.setState(item.id, "failed", err.toSafeJSON())
        const fieldDetail = err.fieldErrors.length
          ? ` Rejected fields: ${err.fieldErrors.map((f) => `${f.fieldName} (${f.errorType})`).join(", ")}.`
          : ""
        results.push({
          itemId: item.id,
          seq: item.seq,
          subject: item.subject,
          state: "failed",
          zohoId: null,
          webUrl: null,
          verified: false,
          message: `${err.message}${fieldDetail}`,
        })
      }
    }
  }

  return {
    batchId,
    workDate: batch.workDate,
    timezone: batch.timezone,
    counts: tally(results),
    items: results,
    stopped,
    notes,
  }
}

/**
 * Read the task back. This is what separates "verified created" from
 * "created but read-back pending", which the result messages must not conflate.
 */
async function verify(
  app: App,
  item: ItemRecord,
  zohoId: string,
): Promise<{ verified: boolean; webUrl: string | null; message: string; note?: string }> {
  try {
    const task = await getTask(app.client!, zohoId)
    app.store.setVerified(item.id, true, task.webUrl)

    if (item.statusIntent === "completed_work_session" && task.statusType !== "Closed") {
      const followUp = await maybeCloseTask(app, item, zohoId, task.status)
      return {
        verified: true,
        webUrl: task.webUrl,
        message: `Created and verified (Zoho ID ${zohoId}). ${followUp.message}`,
        note: followUp.note,
      }
    }

    return {
      verified: true,
      webUrl: task.webUrl,
      message: `Created and verified in Zoho (ID ${zohoId}, status ${task.status ?? "unknown"}).`,
    }
  } catch {
    return {
      verified: false,
      webUrl: null,
      message: `Created in Zoho (ID ${zohoId}) but the read-back failed, so field values are unverified.`,
    }
  }
}

/**
 * Creating a task directly with a Completed status is undocumented; Zoho's own
 * documentation only ever describes updating an existing task. If the create
 * did not close it, we only issue a second write when the user has explicitly
 * enabled it, because that needs an extra OAuth scope.
 */
async function maybeCloseTask(
  app: App,
  item: ItemRecord,
  zohoId: string,
  currentStatus: string | null,
): Promise<{ message: string; note?: string }> {
  const target = app.config.statusMap.completed_work_session
  if (!app.config.statusFollowUp.patchIfNotClosed) {
    return {
      message: `Zoho did not close it on create (status is ${currentStatus ?? "unknown"}).`,
      note:
        `Task ${zohoId} was created but is not closed. Zoho does not document closing a task at ` +
        `creation time. Either close it in Zoho, or set statusFollowUp.patchIfNotClosed to true in ` +
        `your config and add the Desk.activities.tasks.UPDATE scope to your refresh token.`,
    }
  }

  try {
    const patched = await updateTaskStatus(app.client!, zohoId, target!)
    if (patched.statusType === "Closed") {
      return { message: `A follow-up update closed it (status ${patched.status ?? target}).` }
    }
    return {
      message: `A follow-up update was applied but Zoho still reports it as open.`,
      note: `Task ${zohoId} did not close even after an explicit status update. Check the task layout and your agent permissions.`,
    }
  } catch (err) {
    const detail = err instanceof ZohoError ? err.message : "the update request failed"
    return {
      message: `The follow-up status update did not succeed.`,
      note: `Task ${zohoId} remains open: ${detail}`,
    }
  }
}

function explainNonReady(item: ItemRecord): string {
  switch (item.state) {
    case "blocked":
      return `Blocked before sending: ${item.blockedReasons.join(" ")}`
    case "created":
      return `Already created (Zoho ID ${item.zohoId}). Returning the saved result; no new task was made.`
    case "duplicate_skipped":
      return `Skipped as a likely duplicate. ${item.blockedReasons.join(" ")}`
    case "uncertain":
      return "Left uncertain by an earlier attempt. Reconcile before retrying."
    case "failed":
      return "Failed previously. Correct the draft and prepare a new batch."
    default:
      return `In state ${item.state}; not eligible for submission.`
  }
}

function describe(item: ItemRecord, message: string): ItemResult {
  return {
    itemId: item.id,
    seq: item.seq,
    subject: item.subject,
    state: item.state,
    zohoId: item.zohoId,
    webUrl: item.webUrl,
    verified: item.verified,
    message,
  }
}

function tally(results: ItemResult[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const result of results) counts[result.state] = (counts[result.state] ?? 0) + 1
  return counts
}
