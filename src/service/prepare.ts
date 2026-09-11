import { randomUUID } from "node:crypto"
import { BatchInputSchema, type ItemRecord } from "../domain/types.ts"
import { resolveBatch } from "../domain/resolve.ts"
import { SCHEMA_VERSION } from "../state/store.ts"
import { formatTimestampInZone } from "../domain/time.ts"
import type { App } from "./app.ts"

export type PreparedItem = {
  itemId: string
  seq: number
  subject: string
  description: string
  state: string
  clientLabel: string | null
  statusIntent: string
  /** Exactly what would be sent to Zoho. Nothing hidden. */
  payload: Record<string, unknown>
  issues: string[]
}

export type PrepareResult = {
  batchId: string
  workDate: string
  timezone: string
  mode: "preview" | "direct"
  items: PreparedItem[]
  counts: Record<string, number>
  readyToSubmit: boolean
  preview: string
}

export function prepareBatch(
  app: App,
  input: unknown,
  opts: { sourceText?: string | null; now?: number } = {},
): PrepareResult {
  const parsed = BatchInputSchema.parse(input)
  const resolved = resolveBatch(parsed, app.config, app.metadata, { now: opts.now })

  const batchId = randomUUID()
  app.store.createBatch(
    {
      id: batchId,
      createdAt: new Date(opts.now ?? Date.now()).toISOString(),
      workDate: resolved.workDate,
      timezone: app.config.timezone,
      mode: app.config.submissionMode,
      schemaVersion: SCHEMA_VERSION,
      sourceText: opts.sourceText ?? null,
    },
    resolved.items,
    { duplicateWindowDays: app.config.limits.duplicateWindowDays },
  )

  return describeBatch(app, batchId)
}

export function describeBatch(app: App, batchId: string): PrepareResult {
  const batch = app.store.getBatch(batchId)
  if (!batch) throw new Error(`No batch found with ID ${batchId}.`)
  const items = app.store.listItems(batchId)

  const prepared: PreparedItem[] = items.map((item) => ({
    itemId: item.id,
    seq: item.seq,
    subject: item.subject,
    description: item.description,
    state: item.state,
    clientLabel: item.clientLabel,
    statusIntent: item.statusIntent,
    payload: safeParse(item.payloadJson),
    issues: item.blockedReasons,
  }))

  const counts: Record<string, number> = {}
  for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1

  return {
    batchId,
    workDate: batch.workDate,
    timezone: batch.timezone,
    mode: batch.mode,
    items: prepared,
    counts,
    readyToSubmit: items.some((i) => i.state === "ready"),
    preview: renderPreview(batch.workDate, batch.timezone, items),
  }
}

/**
 * The preview shows absolute dates and the exact payload. Relative wording is
 * resolved once, at preparation, so what is shown is what will be sent.
 */
export function renderPreview(workDate: string, timezone: string, items: ItemRecord[]): string {
  const lines: string[] = []
  lines.push(`Work date: ${workDate} (${timezone})`)
  lines.push("")

  for (const item of items) {
    const marker =
      item.state === "ready"
        ? "ready"
        : item.state === "blocked"
          ? "BLOCKED"
          : item.state === "duplicate_skipped"
            ? "DUPLICATE?"
            : item.state
    lines.push(`${item.seq}. [${marker}] ${item.subject}`)
    if (item.description) lines.push(`   ${item.description}`)

    const payload = safeParse(item.payloadJson)
    const details: string[] = []
    if (payload.status) details.push(`status: ${payload.status}`)
    if (payload.priority) details.push(`priority: ${payload.priority}`)
    if (payload.ownerId) details.push(`owner: ${payload.ownerId}`)
    if (payload.departmentId) details.push(`department: ${payload.departmentId}`)
    if (payload.contactId) details.push(`contact: ${payload.contactId}`)
    if (payload.ticketId) details.push(`ticket: ${payload.ticketId}`)
    if (typeof payload.dueDate === "string") {
      details.push(`dueDate: ${formatTimestampInZone(payload.dueDate, timezone)}`)
    }
    if (payload.cf && typeof payload.cf === "object") {
      for (const [key, value] of Object.entries(payload.cf as Record<string, string>)) {
        // Timestamps are shown in the user's own timezone, never as raw UTC.
        const shown = /^\d{4}-\d{2}-\d{2}T/.test(value) ? formatTimestampInZone(value, timezone) : value
        details.push(`${key}: ${shown}`)
      }
    }
    if (details.length) lines.push(`   ${details.join(" | ")}`)

    for (const issue of item.blockedReasons) lines.push(`   ! ${issue}`)
    lines.push(`   source: ${truncate(item.sourceRef, 120)}`)
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}
