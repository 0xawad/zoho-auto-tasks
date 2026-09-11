import path from "node:path"
import fs from "node:fs"
import dotenv from "dotenv"
import { z } from "zod"
import { configDir } from "./paths.ts"
import { REGION_CODES, type RegionCode } from "./regions.ts"

// Explicit process environment values always win over .env values. This keeps
// CI and secret-manager integrations working without a second code path.
export const environmentFile = process.env.ZOHO_AUTO_TASKS_ENV_FILE ?? path.join(configDir(), ".env")

dotenv.config({ path: environmentFile })

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

const numericId = z.string().regex(/^\d+$/, "must be a numeric Zoho ID")

function boolean(value: string | undefined, name: string): boolean | undefined {
  const normalized = optional(value)?.toLowerCase()
  if (!normalized) return undefined
  if (normalized === "true") return true
  if (normalized === "false") return false
  throw new Error(`${name} must be true or false`)
}

function integer(value: string | undefined, name: string): number | undefined {
  const normalized = optional(value)
  if (!normalized) return undefined
  if (!/^\d+$/.test(normalized)) throw new Error(`${name} must be a whole number`)
  return Number(normalized)
}

function json(value: string | undefined, name: string): unknown {
  const normalized = optional(value)
  if (!normalized) return {}
  try {
    return JSON.parse(normalized)
  } catch {
    throw new Error(`${name} must be valid JSON`)
  }
}

const SetupEnvironmentSchema = z
  .object({
    region: z.enum(REGION_CODES as [RegionCode, ...RegionCode[]]),
    timezone: z.string().min(1),
    ownerEmail: z.string().email(),
    orgId: numericId.optional(),
    departmentId: numericId.optional(),
    departmentName: z.string().min(1).optional(),
    priority: z.string().max(120).nullable(),
    statusCompleted: z.string().max(120),
    statusInProgress: z.string().max(120).nullable(),
    statusPlanned: z.string().max(120).nullable(),
    workDateMode: z.enum(["none", "dueDate", "customField"]),
    workDateField: z.string().max(100).nullable(),
    workSessionEnabled: z.boolean(),
    workSessionStart: z.string().regex(/^\d{2}:\d{2}$/),
    workSessionEnd: z.string().regex(/^\d{2}:\d{2}$/),
    workSessionStartField: z.string().max(100).nullable(),
    workSessionEndField: z.string().max(100).nullable(),
    workSessionPercentageField: z.string().max(100).nullable(),
    workSessionPercentage: z.number().int().min(0).max(100),
    workSessionDefaultMinutes: z.number().int().min(5).max(1440),
    workSessionMinMinutes: z.number().int().min(5).max(1440),
    workSessionMaxMinutes: z.number().int().min(5).max(1440),
    workSessionGranularityMinutes: z.number().int().min(1).max(60),
    submissionMode: z.enum(["preview", "direct"]),
    patchIfNotClosed: z.boolean(),
    maxBatchSize: z.number().int().min(1).max(100),
    requestTimeoutMs: z.number().int().min(1000).max(120000),
    maxRetries: z.number().int().min(0).max(10),
    duplicateWindowDays: z.number().int().min(0).max(365),
    retentionDays: z.number().int().min(1).max(3650),
    aliases: z.record(z.string(), z.unknown()),
  })
  .superRefine((value, ctx) => {
    if (!value.departmentId && !value.departmentName) {
      ctx.addIssue({
        code: "custom",
        path: ["departmentId"],
        message: "set ZOHO_DEPARTMENT_ID or ZOHO_DEPARTMENT_NAME",
      })
    }
  })

export type SetupEnvironment = z.infer<typeof SetupEnvironmentSchema>

/** Load the non-secret values needed to turn a fresh install into a usable tenant config. */
export function loadSetupEnvironment(): SetupEnvironment {
  const parsed = SetupEnvironmentSchema.safeParse({
    region: optional(process.env.ZOHO_REGION)?.toLowerCase(), timezone: optional(process.env.ZOHO_TIMEZONE),
    ownerEmail: optional(process.env.ZOHO_OWNER_EMAIL)?.toLowerCase(), orgId: optional(process.env.ZOHO_ORG_ID),
    departmentId: optional(process.env.ZOHO_DEPARTMENT_ID), departmentName: optional(process.env.ZOHO_DEPARTMENT_NAME),
    priority: optional(process.env.ZOHO_DEFAULT_PRIORITY) ?? null,
    statusCompleted: optional(process.env.ZOHO_STATUS_COMPLETED) ?? "Completed",
    statusInProgress: optional(process.env.ZOHO_STATUS_IN_PROGRESS) ?? "In Progress",
    statusPlanned: optional(process.env.ZOHO_STATUS_PLANNED) ?? null,
    workDateMode: optional(process.env.ZOHO_WORK_DATE_MODE) ?? "none",
    workDateField: optional(process.env.ZOHO_WORK_DATE_FIELD) ?? null,
    workSessionEnabled: boolean(process.env.ZOHO_WORK_SESSION_ENABLED, "ZOHO_WORK_SESSION_ENABLED") ?? false,
    workSessionStart: optional(process.env.ZOHO_WORK_SESSION_START) ?? "09:00",
    workSessionEnd: optional(process.env.ZOHO_WORK_SESSION_END) ?? "18:00",
    workSessionStartField: optional(process.env.ZOHO_WORK_SESSION_START_FIELD) ?? null,
    workSessionEndField: optional(process.env.ZOHO_WORK_SESSION_END_FIELD) ?? null,
    workSessionPercentageField: optional(process.env.ZOHO_WORK_SESSION_PERCENTAGE_FIELD) ?? null,
    workSessionPercentage: integer(process.env.ZOHO_WORK_SESSION_PERCENTAGE, "ZOHO_WORK_SESSION_PERCENTAGE") ?? 100,
    workSessionDefaultMinutes: integer(process.env.ZOHO_WORK_SESSION_DEFAULT_MINUTES, "ZOHO_WORK_SESSION_DEFAULT_MINUTES") ?? 60,
    workSessionMinMinutes: integer(process.env.ZOHO_WORK_SESSION_MIN_MINUTES, "ZOHO_WORK_SESSION_MIN_MINUTES") ?? 15,
    workSessionMaxMinutes: integer(process.env.ZOHO_WORK_SESSION_MAX_MINUTES, "ZOHO_WORK_SESSION_MAX_MINUTES") ?? 480,
    workSessionGranularityMinutes: integer(process.env.ZOHO_WORK_SESSION_GRANULARITY_MINUTES, "ZOHO_WORK_SESSION_GRANULARITY_MINUTES") ?? 5,
    submissionMode: optional(process.env.ZOHO_SUBMISSION_MODE) ?? "preview",
    patchIfNotClosed: boolean(process.env.ZOHO_PATCH_IF_NOT_CLOSED, "ZOHO_PATCH_IF_NOT_CLOSED") ?? false,
    maxBatchSize: integer(process.env.ZOHO_MAX_BATCH_SIZE, "ZOHO_MAX_BATCH_SIZE") ?? 25,
    requestTimeoutMs: integer(process.env.ZOHO_REQUEST_TIMEOUT_MS, "ZOHO_REQUEST_TIMEOUT_MS") ?? 20000,
    maxRetries: integer(process.env.ZOHO_MAX_RETRIES, "ZOHO_MAX_RETRIES") ?? 3,
    duplicateWindowDays: integer(process.env.ZOHO_DUPLICATE_WINDOW_DAYS, "ZOHO_DUPLICATE_WINDOW_DAYS") ?? 7,
    retentionDays: integer(process.env.ZOHO_RETENTION_DAYS, "ZOHO_RETENTION_DAYS") ?? 30,
    aliases: json(process.env.ZOHO_ALIASES_JSON, "ZOHO_ALIASES_JSON"),
  })
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => {
      const name = issue.path[0] === "region" ? "ZOHO_REGION" :
        issue.path[0] === "timezone" ? "ZOHO_TIMEZONE" :
        issue.path[0] === "ownerEmail" ? "ZOHO_OWNER_EMAIL" :
        issue.path[0] === "orgId" ? "ZOHO_ORG_ID" :
        issue.path[0] === "departmentName" ? "ZOHO_DEPARTMENT_NAME" : "ZOHO_DEPARTMENT_ID"
      return `${name}: ${issue.message}`
    })
    throw new Error(`.env setup values are invalid:\n  - ${details.join("\n  - ")}`)
  }
  return parsed.data
}

/** Persist credentials alongside the rest of the user-managed local settings, without logging them. */
export function persistEnvironmentCredentials(secrets: {
  clientId: string
  clientSecret: string
  refreshToken: string
}): void {
  let contents = ""
  try {
    contents = fs.readFileSync(environmentFile, "utf8")
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err
  }

  const values = {
    ZOHO_CLIENT_ID: secrets.clientId,
    ZOHO_CLIENT_SECRET: secrets.clientSecret,
    ZOHO_REFRESH_TOKEN: secrets.refreshToken,
  }
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${JSON.stringify(value)}`
    const matcher = new RegExp(`^${key}=.*$`, "m")
    contents = matcher.test(contents) ? contents.replace(matcher, line) : `${contents}${contents.endsWith("\n") ? "" : "\n"}${line}\n`
  }

  fs.mkdirSync(path.dirname(environmentFile), { recursive: true, mode: 0o700 })
  const temporary = `${environmentFile}.tmp-${process.pid}`
  fs.writeFileSync(temporary, contents, { mode: 0o600 })
  fs.chmodSync(temporary, 0o600)
  fs.renameSync(temporary, environmentFile)
}
