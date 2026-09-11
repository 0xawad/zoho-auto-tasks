import type { DeskClient } from "../zoho/client.ts"
import { searchTasks, type TaskRecord } from "../zoho/tasks.ts"
import { ZohoError } from "../zoho/errors.ts"
import { normalizeSubject } from "../domain/fingerprint.ts"
import { toZohoTimestamp } from "../domain/time.ts"
import type { ItemRecord } from "../domain/types.ts"
import type { Store } from "../state/store.ts"

/**
 * Zoho provides no idempotency key (docs/zoho-field-map.md §5), so an
 * interrupted create can only be resolved by looking for the task afterwards.
 * This is deliberately conservative: anything short of exactly one convincing
 * match leaves the item uncertain for a human to check.
 */

export type ReconcileOutcome = {
  itemId: string
  resolution: "created" | "not_found" | "ambiguous" | "unavailable"
  zohoId: string | null
  webUrl: string | null
  message: string
}

/** Window around the attempt in which a matching task must have been created. */
const LEAD_MS = 2 * 60_000
const TRAIL_MS = 5 * 60_000

function attemptWindow(item: ItemRecord): { from: number; to: number } {
  const last = item.attempts[item.attempts.length - 1]
  const start = last?.startedAt ? Date.parse(last.startedAt) : Date.parse(item.updatedAt)
  const end = last?.finishedAt ? Date.parse(last.finishedAt) : Date.parse(item.updatedAt)
  const from = (Number.isFinite(start) ? start : Date.now()) - LEAD_MS
  const to = (Number.isFinite(end) ? end : Date.now()) + TRAIL_MS
  return { from, to }
}

function matches(task: TaskRecord, item: ItemRecord, window: { from: number; to: number }): boolean {
  if (normalizeSubject(task.subject) !== normalizeSubject(item.subject)) return false
  if (!task.createdTime) return false
  const created = Date.parse(task.createdTime)
  if (!Number.isFinite(created)) return false
  return created >= window.from && created <= window.to
}

export async function reconcileItem(
  client: DeskClient,
  store: Store,
  item: ItemRecord,
): Promise<ReconcileOutcome> {
  if (item.zohoId) {
    return {
      itemId: item.id,
      resolution: "created",
      zohoId: item.zohoId,
      webUrl: item.webUrl,
      message: "Already recorded as created locally.",
    }
  }

  const payload = safeParse(item.payloadJson)
  const departmentId = typeof payload.departmentId === "string" ? payload.departmentId : undefined
  const window = attemptWindow(item)

  let found: TaskRecord[]
  try {
    const result = await searchTasks(client, {
      departmentId,
      subject: item.subject,
      createdTimeRange: `${toZohoTimestamp(window.from)},${toZohoTimestamp(window.to)}`,
      limit: 50,
    })
    found = result.tasks.filter((task) => matches(task, item, window))
  } catch (err) {
    const message =
      err instanceof ZohoError
        ? `Reconciliation could not run: ${err.message}`
        : "Reconciliation could not run because the search request failed."
    return { itemId: item.id, resolution: "unavailable", zohoId: null, webUrl: null, message }
  }

  if (found.length === 1) {
    const task = found[0]!
    store.recordCreated(item.id, task.id, task.webUrl, true)
    return {
      itemId: item.id,
      resolution: "created",
      zohoId: task.id,
      webUrl: task.webUrl,
      message: "Found the task in Zoho; the create had succeeded despite the failed response.",
    }
  }

  if (found.length > 1) {
    store.setState(item.id, "uncertain", {
      category: "reconcile_ambiguous",
      message: `Search returned ${found.length} tasks matching this subject and time window.`,
      candidates: found.map((t) => t.id),
    })
    return {
      itemId: item.id,
      resolution: "ambiguous",
      zohoId: null,
      webUrl: null,
      message:
        `Found ${found.length} candidate tasks (${found.map((t) => t.id).join(", ")}). ` +
        `Check Zoho and confirm which, if any, belongs to this item before retrying.`,
    }
  }

  store.setState(item.id, "uncertain", {
    category: "reconcile_not_found",
    message: "No matching task found in the expected creation window.",
  })
  return {
    itemId: item.id,
    resolution: "not_found",
    zohoId: null,
    webUrl: null,
    message:
      "No matching task was found, which suggests the create did not land. " +
      "Search indexing can lag, so confirm in Zoho before resubmitting this item.",
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}
