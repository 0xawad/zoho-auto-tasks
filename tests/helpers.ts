import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseConfig, type Config } from "../src/config/config.ts"
import { Store } from "../src/state/store.ts"
import type { TenantMetadata } from "../src/zoho/metadata.ts"
import type { App } from "../src/service/app.ts"

export function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zat-test-"))
  process.env.ZOHO_AUTO_TASKS_HOME = dir
  return dir
}

export function baseConfig(overrides: Record<string, any> = {}): Config {
  return parseConfig({
    schemaVersion: 1,
    region: "eu",
    orgId: "700000001",
    timezone: "Asia/Beirut",
    defaults: { departmentId: "1000", ownerId: "2000", priority: "Normal" },
    statusMap: {
      completed_work_session: "Completed",
      in_progress: "In Progress",
      planned: "Not Started",
    },
    workDate: { mode: "none", customFieldApiName: null },
    aliases: {},
    statusFollowUp: { patchIfNotClosed: false },
    submissionMode: "preview",
    limits: { maxBatchSize: 25, requestTimeoutMs: 5000, maxRetries: 2, duplicateWindowDays: 7 },
    retentionDays: 30,
    ...overrides,
  })
}

export function metadata(overrides: Partial<TenantMetadata> = {}): TenantMetadata {
  return {
    fetchedAt: new Date().toISOString(),
    organizations: [{ id: "700000001", companyName: "Test" }],
    departments: [{ id: "1000", name: "Support" }],
    agents: [{ id: "2000", name: "Test Agent" }],
    me: { id: "2000", name: "Test Agent" },
    layouts: [],
    taskFields: [],
    statusValues: ["Not Started", "In Progress", "Completed"],
    priorityValues: ["High", "Normal", "Low"],
    mandatoryFieldApiNames: [],
    dateCustomFields: [],
    notes: [],
    ...overrides,
  }
}

export async function testApp(
  opts: { config?: Config; metadata?: TenantMetadata | null; client?: any } = {},
): Promise<App> {
  const store = await Store.open(":memory:")
  return {
    config: opts.config ?? baseConfig(),
    store,
    metadata: opts.metadata === undefined ? metadata() : opts.metadata,
    client: opts.client ?? null,
    tokens: null,
  }
}

export function draft(overrides: Record<string, any> = {}) {
  return {
    sourceRef: "Auditax: installed Ubuntu",
    subject: "Auditax — Ubuntu deployment",
    description: "Installed Ubuntu for Auditax.",
    clientLabel: "Auditax",
    statusIntent: "completed_work_session",
    ...overrides,
  }
}

/** Minimal stand-in for the Zoho client used by the submission engine. */
export class FakeClient {
  calls: Array<{ pathname: string; opts: any }> = []
  private readonly handlers: Array<(pathname: string, opts: any) => any>

  constructor(handlers: Array<(pathname: string, opts: any) => any>) {
    this.handlers = handlers
  }

  async request(pathname: string, opts: any = {}): Promise<any> {
    this.calls.push({ pathname, opts })
    const handler = this.handlers.shift()
    if (!handler) throw new Error(`FakeClient received an unexpected call to ${pathname}`)
    const result = await handler(pathname, opts)
    if (result instanceof Error) throw result
    return { data: result, status: 200, creditsUsed: 1, creditsRemaining: 100 }
  }
}
