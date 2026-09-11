import assert from "node:assert/strict"
import test from "node:test"
import { loadSetupEnvironment } from "../src/config/env.ts"
import { buildSetupConfig } from "../src/service/setup.ts"
import { metadata } from "./helpers.ts"

const ENV_KEYS = ["ZOHO_REGION", "ZOHO_TIMEZONE", "ZOHO_OWNER_EMAIL", "ZOHO_ORG_ID", "ZOHO_DEPARTMENT_ID", "ZOHO_DEPARTMENT_NAME"] as const

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const before = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  try {
    for (const key of ENV_KEYS) values[key] === undefined ? delete process.env[key] : (process.env[key] = values[key])
    run()
  } finally {
    for (const key of ENV_KEYS) before[key] === undefined ? delete process.env[key] : (process.env[key] = before[key])
  }
}

const env = {
  region: "us" as const,
  timezone: "Asia/Beirut",
  ownerEmail: "owner@example.com",
  departmentName: "Support",
  priority: "Normal",
  statusCompleted: "Completed",
  statusInProgress: "In Progress",
  statusPlanned: null,
  workDateMode: "none" as const,
  workDateField: null,
  workSessionEnabled: false,
  workSessionStart: "09:00",
  workSessionEnd: "18:00",
  workSessionStartField: null,
  workSessionEndField: null,
  workSessionPercentageField: null,
  workSessionPercentage: 100,
  workSessionDefaultMinutes: 60,
  workSessionMinMinutes: 15,
  workSessionMaxMinutes: 480,
  workSessionGranularityMinutes: 5,
  submissionMode: "preview" as const,
  patchIfNotClosed: false,
  maxBatchSize: 25,
  requestTimeoutMs: 20000,
  maxRetries: 3,
  duplicateWindowDays: 7,
  retentionDays: 30,
  aliases: {},
}
const tenant = () => metadata({
  organizations: [{ id: "1", companyName: "Example" }],
  departments: [{ id: "10", name: "Support", isEnabled: true }],
  agents: [{ id: "20", name: "Owner", emailId: "owner@example.com", status: "ACTIVE" }],
})

test("setup resolves a unique department name and owner email into Zoho IDs", () => {
  const config = buildSetupConfig(env, tenant())
  assert.equal(config.orgId, "1")
  assert.equal(config.defaults.departmentId, "10")
  assert.equal(config.defaults.ownerId, "20")
  assert.equal(config.statusMap.completed_work_session, "Completed")
  assert.equal(config.defaults.priority, "Normal")
  assert.equal(config.submissionMode, "preview")
})

test("setup prefers an explicit department ID over the department name", () => {
  const config = buildSetupConfig(
    { ...env, departmentId: "11", departmentName: "A stale name" },
    metadata({ ...tenant(), departments: [{ id: "10", name: "Support" }, { id: "11", name: "Operations" }] }),
  )
  assert.equal(config.defaults.departmentId, "11")
})

test("setup preserves all user-managed scheduling and operational settings from .env", () => {
  const config = buildSetupConfig(
    {
      ...env,
      workDateMode: "customField",
      workDateField: "cf_work_date",
      workSessionEnabled: true,
      workSessionStartField: "cf_start",
      workSessionEndField: "cf_end",
      workSessionPercentageField: "cf_percent",
      submissionMode: "direct",
      maxBatchSize: 10,
      retentionDays: 90,
      aliases: { Acme: { contactId: "100", ticketId: null, label: "Acme" } },
    },
    tenant(),
  )
  assert.equal(config.workDate.mode, "customField")
  assert.equal(config.workSession.enabled, true)
  assert.equal(config.workSession.startFieldApiName, "cf_start")
  assert.equal(config.submissionMode, "direct")
  assert.equal(config.limits.maxBatchSize, 10)
  assert.equal(config.retentionDays, 90)
  assert.equal(config.aliases.Acme?.contactId, "100")
})

test("setup refuses an ambiguous department name", () => {
  assert.throws(
    () => buildSetupConfig(env, metadata({ ...tenant(), departments: [{ id: "10", name: "Support" }, { id: "11", name: "support" }] })),
    /Multiple matches were found/,
  )
})

test("setup refuses an owner email that does not resolve to exactly one active agent", () => {
  assert.throws(() => buildSetupConfig({ ...env, ownerEmail: "missing@example.com" }, tenant()), /No unique active Zoho Desk agent matches/)
})

test("setup requires an organization choice when the token can see multiple organizations", () => {
  assert.throws(
    () => buildSetupConfig(env, metadata({ ...tenant(), organizations: [{ id: "1", companyName: "One" }, { id: "2", companyName: "Two" }] })),
    /Set ZOHO_ORG_ID/,
  )
})

test("setup environment accepts a department ID and normalizes the owner email", () => {
  withEnv(
    { ZOHO_REGION: "US", ZOHO_TIMEZONE: "Asia/Beirut", ZOHO_OWNER_EMAIL: "OWNER@EXAMPLE.COM", ZOHO_DEPARTMENT_ID: "10", ZOHO_DEPARTMENT_NAME: undefined, ZOHO_ORG_ID: undefined },
    () => {
      const parsed = loadSetupEnvironment()
      assert.equal(parsed.region, "us")
      assert.equal(parsed.timezone, "Asia/Beirut")
      assert.equal(parsed.ownerEmail, "owner@example.com")
      assert.equal(parsed.departmentId, "10")
    },
  )
})

test("setup environment requires a department selector", () => {
  withEnv(
    { ZOHO_REGION: "us", ZOHO_TIMEZONE: "Asia/Beirut", ZOHO_OWNER_EMAIL: "owner@example.com", ZOHO_DEPARTMENT_ID: undefined, ZOHO_DEPARTMENT_NAME: undefined, ZOHO_ORG_ID: undefined },
    () => assert.throws(() => loadSetupEnvironment(), /ZOHO_DEPARTMENT_ID/),
  )
})
