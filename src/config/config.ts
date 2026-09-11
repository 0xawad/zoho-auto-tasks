import { z } from "zod"
import "./env.ts"
import { configFile, secretsFile, readJsonIfExists } from "./paths.ts"
import { REGION_CODES, REGIONS, type RegionCode } from "./regions.ts"

const CONFIG_SCHEMA_VERSION = 1

const idString = z
  .string()
  .regex(/^[0-9]+$/, "must be a numeric Zoho ID")

/**
 * Two-tier validation on purpose:
 *  - loadConfig() checks structure only, so `discover` can run before the
 *    tenant-specific IDs are known.
 *  - assertSubmitReady() checks that everything required for a live write is
 *    present and resolved. Nothing writes without passing it.
 */
export const ConfigSchema = z
  .object({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
    region: z.enum(REGION_CODES as [RegionCode, ...RegionCode[]]),
    orgId: z.union([idString, z.literal("REPLACE_WITH_ORG_ID")]),
    timezone: z.string().min(1),
    defaults: z.object({
      departmentId: z.string().nullable().default(null),
      ownerId: z.string().nullable().default(null),
      priority: z.string().max(120).nullable().default(null),
    }),
    statusMap: z.object({
      completed_work_session: z.string().max(120).nullable().default(null),
      in_progress: z.string().max(120).nullable().default(null),
      planned: z.string().max(120).nullable().default(null),
    }),
    workDate: z.object({
      /**
       * Where the reporting date goes. Zoho Desk tasks have no work-date field;
       * see docs/zoho-field-map.md. Decided after tenant field discovery.
       */
      mode: z.enum(["none", "dueDate", "customField"]),
      customFieldApiName: z.string().max(100).nullable().default(null),
    }),
    /**
     * Work sessions. Zoho Desk tasks have no writable start/end time, but a
     * portal may define custom DateTime fields for them. Durations are
     * estimated by the agent and scheduled deterministically here, so sessions
     * never overlap and never leave the window.
     */
    workSession: z
      .object({
        enabled: z.boolean().default(false),
        /** Local "HH:MM" bounds in the configured timezone. */
        windowStart: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
        windowEnd: z.string().regex(/^\d{2}:\d{2}$/).default("18:00"),
        startFieldApiName: z.string().max(100).nullable().default(null),
        endFieldApiName: z.string().max(100).nullable().default(null),
        percentageFieldApiName: z.string().max(100).nullable().default(null),
        /** Written verbatim to the percentage field when one is configured. */
        percentageValue: z.number().int().min(0).max(100).default(100),
        defaultMinutes: z.number().int().min(5).max(1440).default(60),
        minMinutes: z.number().int().min(5).max(1440).default(15),
        maxMinutes: z.number().int().min(5).max(1440).default(480),
        granularityMinutes: z.number().int().min(1).max(60).default(5),
      })
      .default({}),
    aliases: z
      .record(
        z.string(),
        z.object({
          contactId: idString.nullable().default(null),
          ticketId: idString.nullable().default(null),
          label: z.string().nullable().default(null),
        }),
      )
      .default({}),
    /**
     * Creating a task directly with a Completed status is undocumented. When the
     * read-back shows the task did not close, a follow-up update is only issued
     * if this is explicitly enabled, because it needs an extra OAuth scope.
     */
    statusFollowUp: z
      .object({ patchIfNotClosed: z.boolean().default(false) })
      .default({ patchIfNotClosed: false }),
    submissionMode: z.enum(["preview", "direct"]).default("preview"),
    limits: z
      .object({
        maxBatchSize: z.number().int().min(1).max(100).default(25),
        requestTimeoutMs: z.number().int().min(1000).max(120000).default(20000),
        maxRetries: z.number().int().min(0).max(10).default(3),
        duplicateWindowDays: z.number().int().min(0).max(365).default(7),
      })
      .default({}),
    retentionDays: z.number().int().min(1).max(3650).default(30),
  })
  .strict()

export type Config = z.infer<typeof ConfigSchema>

export const SecretsSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    refreshToken: z.string().min(1),
  })
  .strict()

export type Secrets = z.infer<typeof SecretsSchema>

export class ConfigError extends Error {
  readonly details: string[]
  constructor(message: string, details: string[] = []) {
    super(details.length ? `${message}\n  - ${details.join("\n  - ")}` : message)
    this.name = "ConfigError"
    this.details = details
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path.length ? i.path.join(".") : "(root)"
    return `${path}: ${i.message}`
  })
}

export function parseConfig(raw: unknown): Config {
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ConfigError("Configuration is invalid", formatIssues(parsed.error))
  }
  try {
    // Fails fast on an invalid IANA zone rather than silently using UTC.
    new Intl.DateTimeFormat("en-US", { timeZone: parsed.data.timezone })
  } catch {
    throw new ConfigError("Configuration is invalid", [
      `timezone: ${JSON.stringify(parsed.data.timezone)} is not a recognised IANA timezone`,
    ])
  }
  return parsed.data
}

export function loadConfig(): Config {
  const file = configFile()
  const raw = readJsonIfExists(file)
  if (raw === null) {
    throw new ConfigError(
      `No configuration found at ${file}. Copy config/example.json there and fill it in.`,
    )
  }
  return parseConfig(raw)
}

/**
 * Secrets come from the restricted secrets file, or from environment variables
 * when set. They are never read into any model-visible surface.
 */
export function loadSecrets(): Secrets {
  const fromEnv = {
    clientId: process.env.ZOHO_CLIENT_ID,
    clientSecret: process.env.ZOHO_CLIENT_SECRET,
    refreshToken: process.env.ZOHO_REFRESH_TOKEN,
  }
  if (fromEnv.clientId && fromEnv.clientSecret && fromEnv.refreshToken) {
    return SecretsSchema.parse(fromEnv)
  }

  const file = secretsFile()
  const raw = readJsonIfExists(file)
  if (raw === null) {
    throw new ConfigError(
      `No credentials found. Provide ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ` +
        `ZOHO_REFRESH_TOKEN, or create ${file} (chmod 600). See README.md.`,
    )
  }
  const parsed = SecretsSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ConfigError(`Credentials file ${file} is invalid`, formatIssues(parsed.error))
  }
  return parsed.data
}

export function accountsHost(config: Config): string {
  return REGIONS[config.region].accounts
}

export function fallbackDeskHost(config: Config): string {
  return REGIONS[config.region].desk
}

/**
 * Everything that must be true before any live write. Returns the list of
 * problems rather than throwing, so callers can report all of them at once.
 */
export function submitReadiness(config: Config): string[] {
  const problems: string[] = []
  if (!/^[0-9]+$/.test(config.orgId)) {
    problems.push("orgId is not set to a numeric organization ID")
  }
  if (!config.defaults.departmentId) {
    problems.push("defaults.departmentId is not set (required by the Zoho create-task API)")
  } else if (!/^[0-9]+$/.test(config.defaults.departmentId)) {
    problems.push(
      `defaults.departmentId is ${JSON.stringify(config.defaults.departmentId)}, not a numeric Zoho ID. ` +
        `Run 'discover' to find the real one.`,
    )
  }
  if (!config.defaults.ownerId) {
    problems.push("defaults.ownerId is not set (no agent would own the created tasks)")
  } else if (!/^[0-9]+$/.test(config.defaults.ownerId)) {
    problems.push(
      `defaults.ownerId is ${JSON.stringify(config.defaults.ownerId)}, not a numeric Zoho agent ID. ` +
        `Run 'discover' to find the real one.`,
    )
  }
  if (!config.statusMap.completed_work_session) {
    problems.push("statusMap.completed_work_session is not set")
  }
  if (config.workDate.mode === "customField" && !config.workDate.customFieldApiName) {
    problems.push("workDate.mode is 'customField' but workDate.customFieldApiName is not set")
  }
  return problems
}

export function assertSubmitReady(config: Config): void {
  const problems = submitReadiness(config)
  if (problems.length) {
    throw new ConfigError(
      `Configuration is not ready for live submission. Run 'discover' and fill in ${configFile()}.`,
      problems,
    )
  }
}
