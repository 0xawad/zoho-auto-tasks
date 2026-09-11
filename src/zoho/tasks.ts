import type { DeskClient } from "./client.ts"

/**
 * Wire-level Zoho Desk task operations. Field names and limits are exactly as
 * verified in docs/zoho-field-map.md §1. Nothing outside this shape is ever
 * sent, and unknown response fields are ignored per Zoho's own convention note.
 */

export type TaskCreatePayload = {
  /** Required. */
  departmentId: string
  /** Required. Max 300 characters. */
  subject: string
  description?: string
  ownerId?: string
  ticketId?: string
  contactId?: string
  /** UTC with a literal trailing Z. Offsets are rejected by Zoho. */
  dueDate?: string
  status?: string
  priority?: string
  category?: string
  /** Custom fields keyed by API name; values are strings capped at 100 chars. */
  cf?: Record<string, string>
}

export type TaskRecord = {
  id: string
  subject: string
  description: string | null
  status: string | null
  /** Response-only. "Open" or "Closed" - the reliable way to detect closure. */
  statusType: string | null
  priority: string | null
  dueDate: string | null
  completedTime: string | null
  createdTime: string | null
  departmentId: string | null
  ownerId: string | null
  ticketId: string | null
  /** Returned by Zoho. Never construct a link by hand. */
  webUrl: string | null
}

function toRecord(raw: any): TaskRecord {
  return {
    id: String(raw?.id ?? ""),
    subject: String(raw?.subject ?? ""),
    description: raw?.description ?? null,
    status: raw?.status ?? null,
    statusType: raw?.statusType ?? null,
    priority: raw?.priority ?? null,
    dueDate: raw?.dueDate ?? null,
    completedTime: raw?.completedTime ?? null,
    createdTime: raw?.createdTime ?? null,
    departmentId: raw?.departmentId != null ? String(raw.departmentId) : null,
    ownerId: raw?.ownerId != null ? String(raw.ownerId) : null,
    ticketId: raw?.ticketId != null ? String(raw.ticketId) : null,
    webUrl: raw?.webUrl ?? null,
  }
}

export async function createTask(client: DeskClient, payload: TaskCreatePayload): Promise<TaskRecord> {
  const result = await client.request<any>("/tasks", {
    method: "POST",
    body: payload,
    isWrite: true,
  })
  return toRecord(result.data)
}

export async function getTask(client: DeskClient, id: string): Promise<TaskRecord> {
  const result = await client.request<any>(`/tasks/${encodeURIComponent(id)}`)
  return toRecord(result.data)
}

export type TaskSearchParams = {
  departmentId?: string
  subject?: string
  assigneeId?: string
  status?: string
  /** "<from>,<to>" in yyyy-MM-ddTHH:mm:ss.SSSZ */
  createdTimeRange?: string
  limit?: number
  sortBy?: string
}

export async function searchTasks(
  client: DeskClient,
  params: TaskSearchParams,
): Promise<{ tasks: TaskRecord[]; count: number }> {
  const result = await client.request<any>("/tasks/search", {
    query: {
      departmentId: params.departmentId,
      subject: params.subject,
      assigneeId: params.assigneeId,
      status: params.status,
      createdTimeRange: params.createdTimeRange,
      // OAS caps search paging lower than the HTML doc; stay within the lower bound.
      limit: Math.min(params.limit ?? 50, 100),
      sortBy: params.sortBy ?? "-createdTime",
    },
  })
  const rows = Array.isArray(result.data?.data) ? result.data.data : []
  return { tasks: rows.map(toRecord), count: Number(result.data?.count ?? rows.length) }
}

export async function updateTaskStatus(
  client: DeskClient,
  id: string,
  status: string,
): Promise<TaskRecord> {
  const result = await client.request<any>(`/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { status },
    isWrite: true,
  })
  return toRecord(result.data)
}
