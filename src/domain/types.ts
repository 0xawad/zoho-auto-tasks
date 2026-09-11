import { z } from "zod"

export const STATUS_INTENTS = ["completed_work_session", "in_progress", "planned"] as const
export type StatusIntent = (typeof STATUS_INTENTS)[number]

export const ITEM_STATES = [
  /** Drafted but not yet validated. */
  "draft",
  /** Validation failed locally; nothing was sent. */
  "blocked",
  /** Validated and eligible for submission. */
  "ready",
  /** Claimed by a submitter. A stale value here means a crash mid-flight. */
  "submitting",
  /** Zoho returned a task ID. */
  "created",
  /** Zoho definitively rejected it; no task exists. */
  "failed",
  /** The request may or may not have created a task. Requires reconciliation. */
  "uncertain",
  /** Suppressed because an equivalent task was already created. */
  "duplicate_skipped",
] as const
export type ItemState = (typeof ITEM_STATES)[number]

export const TERMINAL_STATES: ItemState[] = ["created", "duplicate_skipped"]

/**
 * What the agent hands to the tools. Deliberately narrow: the model supplies
 * wording and intent, never IDs it invented, URLs, or arbitrary field names.
 */
export const DraftInputSchema = z
  .object({
    /** Verbatim fragment of the user's summary this draft came from. */
    sourceRef: z.string().min(1).max(2000),
    subject: z.string().min(1).max(300),
    description: z.string().max(65535).default(""),
    clientLabel: z.string().max(200).nullable().default(null),
    statusIntent: z.enum(STATUS_INTENTS),
    /** Only when the user stated it explicitly. */
    priority: z.string().max(120).nullable().default(null),
    /**
     * How long this work plausibly took, in minutes. An estimate judged from
     * the description; the actual clock times are allocated deterministically
     * by the scheduler, not by the model.
     */
    estimatedMinutes: z.number().int().min(1).max(1440).nullable().default(null),
    /** Only when the user supplied an actual numeric Zoho ID. */
    ticketId: z.string().regex(/^[0-9]+$/).nullable().default(null),
    contactId: z.string().regex(/^[0-9]+$/).nullable().default(null),
    departmentId: z.string().regex(/^[0-9]+$/).nullable().default(null),
    ownerId: z.string().regex(/^[0-9]+$/).nullable().default(null),
  })
  .strict()

export type DraftInput = z.infer<typeof DraftInputSchema>

export const BatchInputSchema = z
  .object({
    /** YYYY-MM-DD, or relative wording resolved once at batch creation. */
    workDate: z.string().min(1),
    tasks: z.array(DraftInputSchema).min(1),
  })
  .strict()

export type BatchInput = z.infer<typeof BatchInputSchema>

export type ResolvedItem = {
  id: string
  seq: number
  sourceRef: string
  subject: string
  description: string
  clientLabel: string | null
  statusIntent: StatusIntent
  payload: Record<string, unknown>
  payloadHash: string
  fingerprint: string
  blockedReasons: string[]
  /** Allocated work session, when work-session scheduling is enabled. */
  session?: { startLocal: string; endLocal: string; durationMinutes: number } | null
  sessionNote?: string | null
}

export type BatchRecord = {
  id: string
  createdAt: string
  workDate: string
  timezone: string
  mode: "preview" | "direct"
  schemaVersion: number
  sourceText: string | null
}

export type Attempt = {
  startedAt: string
  finishedAt: string
  outcome: string
  category?: string | null
  message?: string | null
}

export type ItemRecord = {
  id: string
  batchId: string
  seq: number
  sourceRef: string
  subject: string
  description: string
  clientLabel: string | null
  statusIntent: StatusIntent
  payloadJson: string
  payloadHash: string
  fingerprint: string
  state: ItemState
  zohoId: string | null
  webUrl: string | null
  verified: boolean
  blockedReasons: string[]
  error: Record<string, unknown> | null
  attempts: Attempt[]
  createdAt: string
  updatedAt: string
}
