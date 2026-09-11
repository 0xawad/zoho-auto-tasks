import { ConfigError, loadSecrets, parseConfig, type Config } from "../config/config.ts"
import { loadSetupEnvironment, persistEnvironmentCredentials, type SetupEnvironment } from "../config/env.ts"
import { configFile, metadataCacheFile, readJsonIfExists, writeSecureJson } from "../config/paths.ts"
import { DeskClient } from "../zoho/client.ts"
import { discoverTenant, type TenantMetadata } from "../zoho/metadata.ts"
import { TokenManager } from "../zoho/oauth.ts"

function unique<T>(matches: T[], message: string): T {
  if (matches.length === 1) return matches[0]!
  if (!matches.length) throw new ConfigError(message)
  throw new ConfigError(`${message} Multiple matches were found; use an ID instead.`)
}

function configuredValue(values: string[], preferred: string): string | null {
  return values.find((value) => value.toLowerCase() === preferred.toLowerCase()) ?? null
}

/** Resolve human-friendly setup inputs into the numeric IDs required by the create API. */
export function buildSetupConfig(env: SetupEnvironment, metadata: TenantMetadata): Config {
  const organization = env.orgId
    ? unique(metadata.organizations.filter((organization) => organization.id === env.orgId), `Organization ${env.orgId} was not found for this token.`)
    : unique(metadata.organizations, "This token can access multiple organizations. Set ZOHO_ORG_ID in .env.")

  const department = env.departmentId
    ? unique(metadata.departments.filter((department) => department.id === env.departmentId), `Department ${env.departmentId} was not found or is not active.`)
    : unique(
        metadata.departments.filter(
          (department) => department.name.toLowerCase() === env.departmentName!.toLowerCase(),
        ),
        `No unique active department matches ${JSON.stringify(env.departmentName)}.`,
      )

  const owner = unique(
    metadata.agents.filter((agent) => agent.emailId?.toLowerCase() === env.ownerEmail),
    `No unique active Zoho Desk agent matches ${JSON.stringify(env.ownerEmail)}.`,
  )
  const completed = configuredValue(metadata.statusValues, env.statusCompleted)
  if (!completed) {
    throw new ConfigError(
      `Could not identify the configured completed status ${JSON.stringify(env.statusCompleted)} from this portal.`,
    )
  }

  return parseConfig({
    schemaVersion: 1,
    region: env.region,
    orgId: organization.id,
    timezone: env.timezone,
    defaults: { departmentId: department.id, ownerId: owner.id, priority: env.priority },
    statusMap: {
      completed_work_session: completed,
      in_progress: env.statusInProgress,
      planned: env.statusPlanned,
    },
    workDate: { mode: env.workDateMode, customFieldApiName: env.workDateField },
    workSession: {
      enabled: env.workSessionEnabled,
      windowStart: env.workSessionStart,
      windowEnd: env.workSessionEnd,
      startFieldApiName: env.workSessionStartField,
      endFieldApiName: env.workSessionEndField,
      percentageFieldApiName: env.workSessionPercentageField,
      percentageValue: env.workSessionPercentage,
      defaultMinutes: env.workSessionDefaultMinutes,
      minMinutes: env.workSessionMinMinutes,
      maxMinutes: env.workSessionMaxMinutes,
      granularityMinutes: env.workSessionGranularityMinutes,
    },
    aliases: env.aliases,
    statusFollowUp: { patchIfNotClosed: env.patchIfNotClosed },
    submissionMode: env.submissionMode,
    limits: {
      maxBatchSize: env.maxBatchSize,
      requestTimeoutMs: env.requestTimeoutMs,
      maxRetries: env.maxRetries,
      duplicateWindowDays: env.duplicateWindowDays,
    },
    retentionDays: env.retentionDays,
  })
}

/** Discover a tenant from .env and atomically write the derived local configuration. */
export async function setup(force = false): Promise<Config> {
  if (readJsonIfExists(configFile()) !== null && !force) {
    throw new ConfigError(`Configuration already exists at ${configFile()}. Re-run with 'setup --force' to replace it.`)
  }

  const env = loadSetupEnvironment()
  const bootstrap = parseConfig({
    schemaVersion: 1,
    region: env.region,
    orgId: env.orgId ?? "REPLACE_WITH_ORG_ID",
    timezone: env.timezone,
    defaults: { departmentId: env.departmentId ?? null, ownerId: null, priority: null },
    statusMap: { completed_work_session: env.statusCompleted, in_progress: env.statusInProgress, planned: env.statusPlanned },
    workDate: { mode: env.workDateMode, customFieldApiName: env.workDateField },
    workSession: { enabled: false },
    aliases: env.aliases,
    statusFollowUp: { patchIfNotClosed: env.patchIfNotClosed },
    submissionMode: env.submissionMode,
    limits: { maxBatchSize: env.maxBatchSize, requestTimeoutMs: env.requestTimeoutMs, maxRetries: env.maxRetries, duplicateWindowDays: env.duplicateWindowDays },
    retentionDays: env.retentionDays,
  })
  const secrets = loadSecrets()
  const client = new DeskClient(bootstrap, new TokenManager(bootstrap, secrets))
  const metadata = await discoverTenant(client)
  const config = buildSetupConfig(env, metadata)
  writeSecureJson(configFile(), config)
  writeSecureJson(metadataCacheFile(), metadata)
  persistEnvironmentCredentials(secrets)
  return config
}
