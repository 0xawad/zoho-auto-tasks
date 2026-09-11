import { randomUUID } from "node:crypto"
import type { Config } from "../config/config.ts"
import type { TenantMetadata } from "../zoho/metadata.ts"
import type { BatchInput, DraftInput, ResolvedItem, StatusIntent } from "./types.ts"
import { contentFingerprint, payloadHash } from "./fingerprint.ts"
import { dateToZohoTimestamp, parseDateParts, resolveRelativeDate } from "./time.ts"
import { scheduleSessions, sessionToTimestamps, type ScheduledSession } from "./schedule.ts"

/** Verified Zoho limits. docs/zoho-field-map.md §1. */
export const LIMITS = {
  subject: 300,
  description: 65535,
  status: 120,
  priority: 120,
  category: 120,
  customFieldValue: 100,
} as const

/** Fields the create API accepts and we are willing to send. Nothing else. */
const ALLOWED_PAYLOAD_KEYS = new Set([
  "departmentId",
  "subject",
  "description",
  "ownerId",
  "ticketId",
  "contactId",
  "dueDate",
  "status",
  "priority",
  "cf",
])

export type ResolveResult = {
  workDate: string
  items: ResolvedItem[]
}

export class DraftError extends Error {}

/**
 * Resolve relative wording once, at batch creation, and persist the result so
 * a batch prepared late at night cannot silently change date on submission.
 */
export function resolveWorkDate(input: string, config: Config, now: number = Date.now()): string {
  const resolved = resolveRelativeDate(input, config.timezone, now)
  if (!resolved) {
    throw new DraftError(
      `Could not interpret ${JSON.stringify(input)} as a work date. ` +
        `Use YYYY-MM-DD, or "today" / "yesterday".`,
    )
  }
  parseDateParts(resolved)
  return resolved
}

function lookupAlias(config: Config, label: string | null): { contactId: string | null; ticketId: string | null; problems: string[] } {
  if (!label) return { contactId: null, ticketId: null, problems: [] }
  const needle = label.trim().toLowerCase()
  const matches = Object.entries(config.aliases).filter(([key]) => key.trim().toLowerCase() === needle)
  if (matches.length === 0) return { contactId: null, ticketId: null, problems: [] }
  if (matches.length > 1) {
    return {
      contactId: null,
      ticketId: null,
      problems: [
        `Client "${label}" matches ${matches.length} configured aliases. ` +
          `Association skipped; fix the duplicate alias keys in your config.`,
      ],
    }
  }
  const [, value] = matches[0]!
  return { contactId: value.contactId, ticketId: value.ticketId, problems: [] }
}

function resolveStatus(
  intent: StatusIntent,
  config: Config,
  metadata: TenantMetadata | null,
  problems: string[],
): string | null {
  const mapped = config.statusMap[intent]
  if (!mapped) {
    problems.push(
      `No Zoho status is configured for intent "${intent}". Set statusMap.${intent} in your config.`,
    )
    return null
  }
  if (mapped.length > LIMITS.status) {
    problems.push(`Configured status for "${intent}" exceeds ${LIMITS.status} characters.`)
    return null
  }
  if (metadata && metadata.statusValues.length && !metadata.statusValues.includes(mapped)) {
    problems.push(
      `Status ${JSON.stringify(mapped)} is not a value this Zoho portal accepts. ` +
        `Known values: ${metadata.statusValues.join(", ")}.`,
    )
    return null
  }
  return mapped
}

function resolvePriority(
  draft: DraftInput,
  config: Config,
  metadata: TenantMetadata | null,
  problems: string[],
): string | null {
  const value = draft.priority ?? config.defaults.priority
  if (!value) return null
  if (value.length > LIMITS.priority) {
    problems.push(`Priority exceeds ${LIMITS.priority} characters.`)
    return null
  }
  if (metadata && metadata.priorityValues.length && !metadata.priorityValues.includes(value)) {
    problems.push(
      `Priority ${JSON.stringify(value)} is not a value this Zoho portal accepts. ` +
        `Known values: ${metadata.priorityValues.join(", ")}.`,
    )
    return null
  }
  return value
}

function checkMandatoryFields(
  payload: Record<string, unknown>,
  metadata: TenantMetadata | null,
  problems: string[],
): void {
  if (!metadata) return
  const alwaysHandled = new Set(["subject", "departmentId", "id", "layoutId"])
  for (const apiName of metadata.mandatoryFieldApiNames) {
    if (alwaysHandled.has(apiName)) continue
    const value = apiName.startsWith("cf_")
      ? (payload.cf as Record<string, string> | undefined)?.[apiName]
      : payload[apiName]
    if (value === undefined || value === null || value === "") {
      problems.push(
        `This Zoho portal marks ${JSON.stringify(apiName)} as mandatory for tasks, but nothing ` +
          `is configured to supply it.`,
      )
    }
  }
}

export function resolveBatch(
  input: BatchInput,
  config: Config,
  metadata: TenantMetadata | null,
  opts: { now?: number } = {},
): ResolveResult {
  const workDate = resolveWorkDate(input.workDate, config, opts.now ?? Date.now())

  if (input.tasks.length > config.limits.maxBatchSize) {
    throw new DraftError(
      `Batch contains ${input.tasks.length} tasks, above the configured maximum of ${config.limits.maxBatchSize}.`,
    )
  }

  const items = input.tasks.map((draft, index) => resolveItem(draft, index, workDate, config, metadata))
  applyWorkSessions(input.tasks, items, workDate, config, metadata)

  // The payload hash must be taken after scheduling, so a change of session
  // times counts as a change of payload.
  for (const item of items) item.payloadHash = payloadHash(item.payload)

  return { workDate, items }
}

/**
 * Allocate a work session to each item and write it into the configured custom
 * fields. Scheduling is batch-wide because sessions are packed in sequence.
 */
function applyWorkSessions(
  drafts: DraftInput[],
  items: ResolvedItem[],
  workDate: string,
  config: Config,
  metadata: TenantMetadata | null,
): void {
  const session = config.workSession
  if (!session.enabled) return

  const required = [session.startFieldApiName, session.endFieldApiName].filter(
    (name): name is string => !!name,
  )
  if (required.length !== 2) {
    for (const item of items) {
      item.blockedReasons.push(
        "workSession is enabled but startFieldApiName or endFieldApiName is not configured.",
      )
    }
    return
  }

  // Custom fields are only written after discovery confirms they exist.
  const fieldsToCheck = [...required, session.percentageFieldApiName].filter(
    (name): name is string => !!name,
  )
  if (!metadata || !metadata.taskFields.length) {
    for (const item of items) {
      item.blockedReasons.push(
        "Cannot verify the work-session custom fields because no task field metadata has been " +
          "discovered. Run 'discover' first.",
      )
    }
    return
  }
  const missing = fieldsToCheck.filter((name) => !metadata.taskFields.some((f) => f.apiName === name))
  if (missing.length) {
    for (const item of items) {
      item.blockedReasons.push(
        `Work-session custom field(s) ${missing.map((m) => JSON.stringify(m)).join(", ")} do not exist ` +
          `on tasks in this portal.`,
      )
    }
    return
  }

  const result = scheduleSessions(
    drafts.map((draft) => draft.estimatedMinutes),
    {
      windowStart: session.windowStart,
      windowEnd: session.windowEnd,
      defaultMinutes: session.defaultMinutes,
      minMinutes: session.minMinutes,
      maxMinutes: session.maxMinutes,
      granularityMinutes: session.granularityMinutes,
    },
  )

  if (result.overflow) {
    for (const item of items) item.blockedReasons.push(...result.notes)
    return
  }

  items.forEach((item, index) => {
    const slot = result.sessions[index]
    if (!slot) return
    const stamps = sessionToTimestamps(workDate, slot, config.timezone)
    if (!stamps) {
      item.blockedReasons.push(
        `The session ${slot.startLocal}-${slot.endLocal} does not exist on ${workDate} in ` +
          `${config.timezone}, because of a daylight-saving transition.`,
      )
      return
    }

    const cf: Record<string, string> = { ...((item.payload.cf as Record<string, string>) ?? {}) }
    cf[session.startFieldApiName!] = stamps.start
    cf[session.endFieldApiName!] = stamps.end
    if (session.percentageFieldApiName) {
      cf[session.percentageFieldApiName] = String(session.percentageValue)
    }

    for (const [key, value] of Object.entries(cf)) {
      if (value.length > LIMITS.customFieldValue) {
        item.blockedReasons.push(
          `Custom field ${JSON.stringify(key)} value exceeds the ${LIMITS.customFieldValue}-character limit.`,
        )
      }
    }

    item.payload.cf = cf
    item.session = slot
    if (result.compressed) item.sessionNote = result.notes[0] ?? null
  })
}

function resolveItem(
  draft: DraftInput,
  index: number,
  workDate: string,
  config: Config,
  metadata: TenantMetadata | null,
): ResolvedItem {
  const problems: string[] = []

  const subject = draft.subject.trim()
  if (!subject) problems.push("Subject is empty.")
  if (subject.length > LIMITS.subject) {
    problems.push(`Subject is ${subject.length} characters; Zoho allows ${LIMITS.subject}.`)
  }

  const description = draft.description ?? ""
  if (description.length > LIMITS.description) {
    problems.push(`Description is ${description.length} characters; Zoho allows ${LIMITS.description}.`)
  }

  const departmentId = draft.departmentId ?? config.defaults.departmentId
  if (!departmentId) {
    problems.push("No department is configured or supplied; Zoho requires departmentId on create.")
  } else if (!/^[0-9]+$/.test(departmentId)) {
    problems.push(
      `Department ${JSON.stringify(departmentId)} is not a numeric Zoho ID. Run 'discover' and set defaults.departmentId.`,
    )
  } else if (metadata && metadata.departments.length && !metadata.departments.some((d) => d.id === departmentId)) {
    problems.push(`Department ID ${departmentId} does not exist in this Zoho portal.`)
  }

  const ownerId = draft.ownerId ?? config.defaults.ownerId
  if (ownerId && !/^[0-9]+$/.test(ownerId)) {
    problems.push(
      `Owner ${JSON.stringify(ownerId)} is not a numeric Zoho agent ID. Run 'discover' and set defaults.ownerId.`,
    )
  } else if (ownerId && metadata && metadata.agents.length && !metadata.agents.some((a) => a.id === ownerId)) {
    problems.push(`Owner ID ${ownerId} is not an active agent in this Zoho portal.`)
  }

  const status = resolveStatus(draft.statusIntent, config, metadata, problems)
  const priority = resolvePriority(draft, config, metadata, problems)

  const alias = lookupAlias(config, draft.clientLabel)
  problems.push(...alias.problems)
  const contactId = draft.contactId ?? alias.contactId
  const ticketId = draft.ticketId ?? alias.ticketId

  const payload: Record<string, unknown> = {}
  if (departmentId) payload.departmentId = departmentId
  payload.subject = subject
  if (description) payload.description = description
  if (ownerId) payload.ownerId = ownerId
  if (contactId) payload.contactId = contactId
  if (ticketId) payload.ticketId = ticketId
  if (status) payload.status = status
  if (priority) payload.priority = priority

  // The work date has no native home on a Zoho task; see docs/zoho-field-map.md §1.
  if (config.workDate.mode === "dueDate") {
    payload.dueDate = dateToZohoTimestamp(workDate, config.timezone)
  } else if (config.workDate.mode === "customField") {
    const apiName = config.workDate.customFieldApiName
    if (!apiName) {
      problems.push("workDate.mode is 'customField' but no customFieldApiName is configured.")
    } else if (workDate.length > LIMITS.customFieldValue) {
      problems.push(`Work date value exceeds the ${LIMITS.customFieldValue}-character custom field limit.`)
    } else if (!metadata || !metadata.taskFields.length) {
      // A custom field is only ever sent when it has been verified to exist on
      // tasks in this portal. An unverified field name is never guessed at.
      problems.push(
        `Cannot verify that custom field ${JSON.stringify(apiName)} exists, because no task field ` +
          `metadata has been discovered. Run 'discover' first.`,
      )
    } else if (!metadata.taskFields.some((f) => f.apiName === apiName)) {
      problems.push(`Custom field ${JSON.stringify(apiName)} does not exist on tasks in this portal.`)
    } else {
      payload.cf = { [apiName]: workDate }
    }
  }

  checkMandatoryFields(payload, metadata, problems)

  for (const key of Object.keys(payload)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) {
      problems.push(`Refusing to send unknown field ${JSON.stringify(key)}.`)
      delete payload[key]
    }
  }

  return {
    id: randomUUID(),
    seq: index + 1,
    sourceRef: draft.sourceRef,
    subject,
    description,
    clientLabel: draft.clientLabel,
    statusIntent: draft.statusIntent,
    payload,
    payloadHash: payloadHash(payload),
    fingerprint: contentFingerprint({
      orgId: config.orgId,
      departmentId: departmentId ?? null,
      ownerId: ownerId ?? null,
      workDate,
      subject,
    }),
    blockedReasons: problems,
  }
}
