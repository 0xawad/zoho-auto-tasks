import type { DeskClient } from "./client.ts"
import { ZohoError } from "./errors.ts"

/**
 * Read-only tenant discovery. Everything the plan deferred - the real
 * department, the real agent, the real status/priority picklists, the real
 * mandatory fields and whether any usable work-date field exists - is answered
 * from here rather than assumed.
 *
 * Endpoints: docs/zoho-field-map.md §6.
 */

export type Organization = { id: string; companyName?: string; portalURL?: string }
export type Department = { id: string; name: string; isEnabled?: boolean }
export type Agent = { id: string; name: string; emailId?: string; status?: string }

export type TaskField = {
  id: string | null
  apiName: string
  displayLabel: string
  type: string | null
  isCustomField: boolean
  isMandatory: boolean
  maxLength: number | null
  allowedValues: string[]
}

export type Layout = { id: string; name: string; departmentId?: string | null; status?: string }

export type TenantMetadata = {
  fetchedAt: string
  organizations: Organization[]
  departments: Department[]
  agents: Agent[]
  me: Agent | null
  layouts: Layout[]
  taskFields: TaskField[]
  statusValues: string[]
  priorityValues: string[]
  mandatoryFieldApiNames: string[]
  /** Custom fields that look like they could carry a work date. */
  dateCustomFields: TaskField[]
  notes: string[]
}

/**
 * Zoho's own documentation warns that response fields are dynamic (profile
 * level field filtering), so every extractor below is defensive and never
 * assumes a shape that was not observed.
 */
function asArray(value: any): any[] {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.data)) return value.data
  return []
}

function pickAllowedValues(field: any): string[] {
  const candidates = [field?.allowedValues, field?.values, field?.pickListValues, field?.options]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    const values = candidate
      .map((v: any) => (typeof v === "string" ? v : (v?.value ?? v?.name ?? v?.displayLabel ?? null)))
      .filter((v: any): v is string => typeof v === "string" && v.length > 0)
    if (values.length) return values
  }
  return []
}

function normalizeField(raw: any): TaskField {
  return {
    id: raw?.id != null ? String(raw.id) : null,
    apiName: String(raw?.apiName ?? raw?.name ?? ""),
    displayLabel: String(raw?.displayLabel ?? raw?.label ?? raw?.apiName ?? ""),
    type: raw?.type != null ? String(raw.type) : null,
    isCustomField: raw?.isCustomField === true || raw?.isCustomField === "true",
    isMandatory: raw?.isMandatory === true || raw?.isMandatory === "true" || raw?.required === true,
    maxLength: Number.isFinite(Number(raw?.maxLength)) ? Number(raw.maxLength) : null,
    allowedValues: pickAllowedValues(raw),
  }
}

async function tryGet<T>(client: DeskClient, pathname: string, query?: Record<string, any>): Promise<{ data: T | null; note: string | null }> {
  try {
    const result = await client.request<T>(pathname, { query })
    return { data: result.data, note: null }
  } catch (err) {
    if (err instanceof ZohoError && (err.category === "notfound" || err.category === "config")) {
      return { data: null, note: `${pathname}: ${err.message}` }
    }
    throw err
  }
}

/**
 * Read recent tasks and collect the status and priority values actually in use.
 * A fallback for portals where the picklist endpoints return nothing.
 */
async function sampleFieldValues(
  client: DeskClient,
): Promise<{ statuses: string[]; priorities: string[]; count: number }> {
  const result = await tryGet<any>(client, "/tasks", { limit: 100, sortBy: "-createdTime" })
  const rows = asArray(result.data)
  const statuses = new Set<string>()
  const priorities = new Set<string>()
  for (const row of rows) {
    if (typeof row?.status === "string" && row.status) statuses.add(row.status)
    if (typeof row?.priority === "string" && row.priority) priorities.add(row.priority)
  }
  return { statuses: [...statuses].sort(), priorities: [...priorities].sort(), count: rows.length }
}

export async function discoverTenant(client: DeskClient): Promise<TenantMetadata> {
  const notes: string[] = []

  const orgs = await tryGet<any>(client, "/organizations")
  if (orgs.note) notes.push(orgs.note)

  // Every endpoint except /organizations needs a real org ID. If the config
  // still holds a placeholder, adopt the organization this token belongs to so
  // discovery can proceed and report the ID to put in the config.
  if (!client.effectiveOrgId()) {
    const found = asArray(orgs.data)
    if (found.length === 1) {
      client.setOrgId(String(found[0].id))
      notes.push(`Using organization ${found[0].id} for discovery. Set "orgId" in your config to this value.`)
    } else if (found.length > 1) {
      notes.push(
        `This token can see ${found.length} organizations. Set "orgId" in your config to the one you want ` +
          `before discovery can read departments and agents.`,
      )
    }
  }

  const departments = await tryGet<any>(client, "/departments", { limit: 200, isEnabled: true })
  if (departments.note) notes.push(departments.note)

  const agents = await tryGet<any>(client, "/agents", { limit: 200, status: "ACTIVE" })
  if (agents.note) notes.push(agents.note)

  const me = await tryGet<any>(client, "/agents/me")
  if (me.note) notes.push(me.note)

  const layouts = await tryGet<any>(client, "/layouts", { module: "tasks" })
  if (layouts.note) notes.push(layouts.note)

  const fields = await tryGet<any>(client, "/fields", { module: "tasks" })
  if (fields.note) notes.push(fields.note)

  const taskFields = asArray(fields.data).map(normalizeField).filter((f) => f.apiName.length > 0)

  const statusField = taskFields.find((f) => f.apiName.toLowerCase() === "status")
  const priorityField = taskFields.find((f) => f.apiName.toLowerCase() === "priority")

  let statusValues = statusField?.allowedValues ?? []
  let priorityValues = priorityField?.allowedValues ?? []

  // Picklist values are layout-scoped; fall back to the layout endpoint when the
  // field listing did not carry them.
  const layoutList: Layout[] = asArray(layouts.data).map((l: any) => ({
    id: String(l?.id ?? ""),
    name: String(l?.name ?? l?.layoutName ?? ""),
    departmentId: l?.departmentId != null ? String(l.departmentId) : null,
    status: l?.status != null ? String(l.status) : undefined,
  }))

  const primaryLayout = layoutList[0]
  if (primaryLayout?.id) {
    if (!statusValues.length && statusField?.id) {
      const picked = await tryGet<any>(client, `/layouts/${primaryLayout.id}/fields/${statusField.id}/value`)
      statusValues = pickAllowedValues(picked.data) || []
      if (picked.note) notes.push(picked.note)
    }
    if (!priorityValues.length && priorityField?.id) {
      const picked = await tryGet<any>(client, `/layouts/${primaryLayout.id}/fields/${priorityField.id}/value`)
      priorityValues = pickAllowedValues(picked.data) || []
      if (picked.note) notes.push(picked.note)
    }
  }

  // Zoho does not always expose picklist values through the field or layout
  // endpoints. When that happens, learn the values actually in use from recent
  // tasks. This is a sample, not an authoritative enumeration, so it is flagged.
  if (!statusValues.length || !priorityValues.length) {
    const sampled = await sampleFieldValues(client)
    if (!statusValues.length && sampled.statuses.length) {
      statusValues = sampled.statuses
      notes.push(
        `Task status values were not readable from the API. Derived from ${sampled.count} recent tasks: ` +
          `${sampled.statuses.join(", ")}. Other values may exist; check the task form if one is missing.`,
      )
    }
    if (!priorityValues.length && sampled.priorities.length) {
      priorityValues = sampled.priorities
      notes.push(
        `Task priority values were not readable from the API. Derived from ${sampled.count} recent tasks: ` +
          `${sampled.priorities.join(", ")}.`,
      )
    }
    if (!statusValues.length) {
      notes.push(
        "Could not read or infer the task status picklist. Set statusMap manually from the values " +
          "visible in the Zoho Desk task form.",
      )
    }
  }

  const meAgent = me.data
    ? {
        id: String(me.data.id ?? ""),
        name: [me.data.firstName, me.data.lastName].filter(Boolean).join(" ").trim() || String(me.data.name ?? ""),
        emailId: me.data.emailId,
        status: me.data.status,
      }
    : null

  return {
    fetchedAt: new Date().toISOString(),
    organizations: asArray(orgs.data).map((o: any) => ({
      id: String(o?.id ?? ""),
      companyName: o?.companyName,
      portalURL: o?.portalURL,
    })),
    departments: asArray(departments.data).map((d: any) => ({
      id: String(d?.id ?? ""),
      name: String(d?.name ?? ""),
      isEnabled: d?.isEnabled,
    })),
    agents: asArray(agents.data).map((a: any) => ({
      id: String(a?.id ?? ""),
      name: [a?.firstName, a?.lastName].filter(Boolean).join(" ").trim() || String(a?.name ?? ""),
      emailId: a?.emailId,
      status: a?.status,
    })),
    me: meAgent,
    layouts: layoutList,
    taskFields,
    statusValues,
    priorityValues,
    mandatoryFieldApiNames: taskFields.filter((f) => f.isMandatory).map((f) => f.apiName),
    dateCustomFields: taskFields.filter(
      (f) => f.isCustomField && /date/i.test(`${f.type ?? ""} ${f.apiName} ${f.displayLabel}`),
    ),
    notes,
  }
}
