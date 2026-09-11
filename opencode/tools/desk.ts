import { tool } from "@opencode-ai/plugin"
import { openApp } from "../../src/service/app.ts"
import { prepareBatch, describeBatch } from "../../src/service/prepare.ts"
import { submitBatch } from "../../src/service/submit.ts"
import { reconcileItem } from "../../src/service/reconcile.ts"
import { submitReadiness } from "../../src/config/config.ts"
import { RECONCILE_STALE_MS } from "../../src/state/store.ts"
import { redactUnknown } from "../../src/util/redact.ts"

/**
 * Thin adapter. All policy lives in src/; this layer only validates arguments,
 * calls the core, and returns sanitized text.
 *
 * The agent never sees credentials, never chooses a URL, and never supplies a
 * raw HTTP request. There is deliberately no generic request tool here.
 */

const s = tool.schema

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof openApp>>) => Promise<T> | T): Promise<T> {
  const app = await openApp()
  try {
    return await fn(app)
  } finally {
    app.store.close()
  }
}

function fail(err: unknown): string {
  return JSON.stringify({ ok: false, error: redactUnknown(err instanceof Error ? err.message : err) }, null, 2)
}

const draftSchema = s.object({
  sourceRef: s.string().describe("The verbatim fragment of the user's summary this task came from"),
  subject: s.string().max(300).describe("Professional, action-oriented title. Max 300 characters"),
  description: s.string().max(65535).describe("Faithful description. State only outcomes the user supplied"),
  clientLabel: s.string().nullable().optional().describe("Client or account name mentioned by the user, if any"),
  statusIntent: s
    .enum(["completed_work_session", "in_progress", "planned"])
    .describe("completed_work_session for finished work, even if the underlying issue is unresolved"),
  priority: s.string().nullable().optional().describe("Only if the user stated a priority explicitly"),
  estimatedMinutes: s
    .number()
    .int()
    .min(1)
    .max(1440)
    .nullable()
    .optional()
    .describe(
      "How long this work plausibly took, in minutes, judged from the described scope. " +
        "The tool allocates the actual clock times; do not attempt to pick start or end times yourself",
    ),
  ticketId: s.string().nullable().optional().describe("Only if the user supplied a real numeric Zoho ticket ID"),
  contactId: s.string().nullable().optional().describe("Only if the user supplied a real numeric Zoho contact ID"),
  departmentId: s.string().nullable().optional().describe("Override for the configured department"),
  ownerId: s.string().nullable().optional().describe("Override for the configured owner"),
})

export const get_context = tool({
  description:
    "Return the configured Zoho Desk defaults, the valid status and priority values for this portal, " +
    "and whether the integration is ready to submit. Call this before drafting.",
  args: {},
  async execute() {
    try {
      return await withApp((app) => {
        const problems = submitReadiness(app.config)
        return JSON.stringify(
          {
            ok: true,
            timezone: app.config.timezone,
            submissionMode: app.config.submissionMode,
            workDatePlacement: app.config.workDate.mode,
            statusMap: app.config.statusMap,
            defaultPriority: app.config.defaults.priority,
            knownStatusValues: app.metadata?.statusValues ?? [],
            knownPriorityValues: app.metadata?.priorityValues ?? [],
            knownClients: Object.keys(app.config.aliases),
            workSession: app.config.workSession.enabled
              ? {
                  enabled: true,
                  window: `${app.config.workSession.windowStart}-${app.config.workSession.windowEnd}`,
                  note:
                    "Supply estimatedMinutes per task. Sessions are packed back to back inside this " +
                    "window by the tool; you must not choose clock times.",
                }
              : { enabled: false },
            metadataFetchedAt: app.metadata?.fetchedAt ?? null,
            readyToSubmit: problems.length === 0,
            blockers: problems,
            limits: { subject: 300, description: 65535 },
          },
          null,
          2,
        )
      })
    } catch (err) {
      return fail(err)
    }
  },
})

export const prepare_batch = tool({
  description:
    "Validate and persist a batch of drafted tasks, returning a preview with the exact payloads and any " +
    "blocking issues. Writes nothing to Zoho. Call this once per daily summary.",
  args: {
    workDate: s
      .string()
      .describe("The work date as YYYY-MM-DD, or 'today' / 'yesterday'. Resolved once, in the configured timezone"),
    tasks: s.array(draftSchema).min(1).describe("One entry per distinct work item, not per verb"),
    sourceText: s.string().optional().describe("The user's original summary, stored for traceability"),
  },
  async execute(args) {
    try {
      return await withApp((app) => {
        const result = prepareBatch(
          app,
          { workDate: args.workDate, tasks: args.tasks },
          { sourceText: args.sourceText ?? null },
        )
        return JSON.stringify(
          {
            ok: true,
            batchId: result.batchId,
            workDate: result.workDate,
            timezone: result.timezone,
            mode: result.mode,
            counts: result.counts,
            readyToSubmit: result.readyToSubmit,
            items: result.items,
            preview: result.preview,
          },
          null,
          2,
        )
      })
    } catch (err) {
      return fail(err)
    }
  },
})

export const submit_batch = tool({
  description:
    "Create the ready items of a prepared batch in Zoho Desk. Items already created are returned from saved " +
    "state without being created again. Reports each item as created, blocked, failed, uncertain or duplicate.",
  args: {
    batchId: s.string().describe("The batch ID returned by prepare_batch"),
  },
  async execute(args) {
    try {
      return await withApp(async (app) => {
        const report = await submitBatch(app, args.batchId)
        return JSON.stringify({ ok: true, ...report }, null, 2)
      })
    } catch (err) {
      return fail(err)
    }
  },
})

export const get_batch = tool({
  description: "Show the current durable state and results of a batch, including Zoho IDs and outstanding actions.",
  args: {
    batchId: s.string().describe("The batch ID"),
  },
  async execute(args) {
    try {
      return await withApp((app) => {
        const result = describeBatch(app, args.batchId)
        const items = app.store.listItems(args.batchId).map((item) => ({
          itemId: item.id,
          seq: item.seq,
          subject: item.subject,
          state: item.state,
          zohoId: item.zohoId,
          webUrl: item.webUrl,
          verified: item.verified,
          issues: item.blockedReasons,
        }))
        return JSON.stringify({ ok: true, batchId: args.batchId, counts: result.counts, items }, null, 2)
      })
    } catch (err) {
      return fail(err)
    }
  },
})

export const reconcile_batch = tool({
  description:
    "Resolve uncertain items by searching Zoho for a task matching the subject and creation window. " +
    "Read-only: it never creates anything and never retries a write.",
  args: {
    batchId: s.string().describe("The batch ID"),
  },
  async execute(args) {
    try {
      return await withApp(async (app) => {
        if (!app.client) return fail("No Zoho credentials are configured.")
        app.store.recoverStaleSubmitting(RECONCILE_STALE_MS)
        const uncertain = app.store.itemsInState(args.batchId, ["uncertain"])
        const outcomes = []
        for (const item of uncertain) {
          outcomes.push(await reconcileItem(app.client, app.store, item))
        }
        return JSON.stringify({ ok: true, batchId: args.batchId, reconciled: outcomes.length, outcomes }, null, 2)
      })
    } catch (err) {
      return fail(err)
    }
  },
})

export const confirm_distinct = tool({
  description:
    "Mark an item that was flagged as a likely duplicate as genuinely distinct work, making it eligible for " +
    "submission. Use only after the user confirms it.",
  args: {
    itemId: s.string().describe("The item ID shown in the duplicate warning"),
  },
  async execute(args) {
    try {
      return await withApp((app) => {
        const ok = app.store.confirmDistinct(args.itemId)
        return JSON.stringify({
          ok,
          message: ok
            ? "Item is now ready to submit."
            : "That item was not in a duplicate-flagged state; nothing changed.",
        })
      })
    } catch (err) {
      return fail(err)
    }
  },
})
