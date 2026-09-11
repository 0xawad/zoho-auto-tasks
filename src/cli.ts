#!/usr/bin/env node
import fs from "node:fs"
import { openApp, saveMetadataCache } from "./service/app.ts"
import { prepareBatch, describeBatch } from "./service/prepare.ts"
import { submitBatch } from "./service/submit.ts"
import { reconcileItem } from "./service/reconcile.ts"
import { discoverTenant } from "./zoho/metadata.ts"
import { connect } from "./service/connect.ts"
import { setup } from "./service/setup.ts"
import { ConfigError, submitReadiness } from "./config/config.ts"
import { RECONCILE_STALE_MS } from "./state/store.ts"
import { configFile, secretsFile, dataDir } from "./config/paths.ts"
import { ZohoError } from "./zoho/errors.ts"
import { redactUnknown } from "./util/redact.ts"

const USAGE = `zoho-auto-tasks

  connect                Guided one-time credential setup (exchanges a self-client code)
  setup [--force]        Discover the .env tenant and write its derived configuration
  doctor                 Check configuration and credentials without writing anything
  discover               Read tenant metadata from Zoho and cache it (read-only)
  prepare [file]         Build a batch from a JSON draft file, or stdin
  show <batchId>         Show a prepared batch and its current results
  submit <batchId>       Create the ready items in Zoho
  reconcile <batchId>    Resolve uncertain items by searching Zoho
  confirm <itemId>       Mark a duplicate-flagged item as distinct work
  purge                  Apply the configured raw-text retention policy

All commands are safe to re-run. Only 'submit' writes to Zoho.`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case undefined:
    case "-h":
    case "--help":
      console.log(USAGE)
      return 0
    case "connect":
      return await connect()
    case "setup":
      return await setupTenant(rest)
    case "doctor":
      return await doctor()
    case "discover":
      return await discover()
    case "prepare":
      return await prepare(rest[0])
    case "show":
      return await show(rest[0])
    case "submit":
      return await submit(rest[0])
    case "reconcile":
      return await reconcile(rest[0])
    case "confirm":
      return await confirm(rest[0])
    case "purge":
      return await purge()
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`)
      return 2
  }
}

async function setupTenant(args: string[]): Promise<number> {
  if (args.some((arg) => arg !== "--force")) {
    console.error("Usage: setup [--force]")
    return 2
  }
  const config = await setup(args.includes("--force"))
  console.log(`Configured Zoho Desk organization ${config.orgId}.`)
  console.log(`Owner: ${config.defaults.ownerId} | Department: ${config.defaults.departmentId}`)
  console.log(`Saved derived configuration to ${configFile()} (mode 600).`)
  console.log("Next: node src/cli.ts doctor")
  return 0
}

async function doctor(): Promise<number> {
  console.log(`Config file:   ${configFile()}`)
  console.log(`Secrets file:  ${secretsFile()}`)
  console.log(`Data directory:${dataDir()}`)
  console.log("")

  const app = await openApp()
  console.log(`Region:        ${app.config.region}`)
  console.log(`Organization:  ${app.config.orgId}`)
  console.log(`Timezone:      ${app.config.timezone}`)
  console.log(`Mode:          ${app.config.submissionMode}`)
  console.log(`Work date:     ${app.config.workDate.mode}`)
  console.log(`Credentials:   ${app.client ? "present" : "MISSING"}`)
  console.log(`Metadata cache:${app.metadata ? ` fetched ${app.metadata.fetchedAt}` : " none (run discover)"}`)

  const problems = submitReadiness(app.config)
  console.log("")
  if (problems.length) {
    console.log("Not ready to submit:")
    for (const problem of problems) console.log(`  - ${problem}`)
  } else {
    console.log("Configuration is complete for live submission.")
  }

  if (app.client) {
    try {
      const result = await app.client.request<any>("/organizations")
      const orgs = Array.isArray(result.data?.data) ? result.data.data : []
      console.log(`\nZoho connectivity: OK (${orgs.length} organization(s) visible).`)
    } catch (err) {
      console.log(`\nZoho connectivity: FAILED - ${err instanceof Error ? err.message : String(err)}`)
      app.store.close()
      return 1
    }
  }

  app.store.close()
  return problems.length ? 1 : 0
}

async function discover(): Promise<number> {
  const app = await openApp({ requireCredentials: true })
  if (!app.client) throw new ConfigError("No credentials configured.")

  console.log("Reading tenant metadata (read-only)…\n")
  const metadata = await discoverTenant(app.client)
  saveMetadataCache(metadata)

  const section = (title: string) => console.log(`\n${title}\n${"-".repeat(title.length)}`)

  section("Organizations")
  for (const org of metadata.organizations) console.log(`  ${org.id}  ${org.companyName ?? ""}`)

  section("Departments")
  for (const dept of metadata.departments) console.log(`  ${dept.id}  ${dept.name}`)

  section("Agents")
  for (const agent of metadata.agents.slice(0, 50)) {
    console.log(`  ${agent.id}  ${agent.name}${agent.emailId ? `  <${agent.emailId}>` : ""}`)
  }
  if (metadata.me) console.log(`  (you: ${metadata.me.id} ${metadata.me.name})`)

  section("Task status values")
  console.log(metadata.statusValues.length ? `  ${metadata.statusValues.join(", ")}` : "  (not readable from the API)")

  section("Task priority values")
  console.log(metadata.priorityValues.length ? `  ${metadata.priorityValues.join(", ")}` : "  (not readable from the API)")

  section("Mandatory task fields")
  console.log(metadata.mandatoryFieldApiNames.length ? `  ${metadata.mandatoryFieldApiNames.join(", ")}` : "  none beyond the API defaults")

  section("Custom task fields")
  const custom = metadata.taskFields.filter((f) => f.isCustomField)
  if (!custom.length) console.log("  none")
  for (const field of custom) {
    console.log(`  ${field.apiName}  (${field.type ?? "unknown type"})  ${field.displayLabel}`)
  }

  section("Work-date placement")
  if (metadata.dateCustomFields.length) {
    console.log("  Candidate custom fields for the work date:")
    for (const field of metadata.dateCustomFields) console.log(`    ${field.apiName}  ${field.displayLabel}`)
    console.log('  Set workDate.mode to "customField" and workDate.customFieldApiName accordingly.')
  } else {
    console.log("  No date-like custom field exists on tasks.")
    console.log('  Choose workDate.mode "dueDate" (uses dueDate as the reporting date) or "none".')
  }

  if (metadata.notes.length) {
    section("Notes")
    for (const note of metadata.notes) console.log(`  - ${note}`)
  }

  console.log(`\nCached to ${dataDir()}/metadata.json. Update ${configFile()} with the IDs above.`)
  app.store.close()
  return 0
}

async function prepare(file?: string): Promise<number> {
  const raw = file && file !== "-" ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8")
  const { sourceText, ...input } = JSON.parse(raw)
  const app = await openApp()
  const result = prepareBatch(app, input, {
    sourceText: typeof sourceText === "string" ? sourceText : null,
  })
  console.log(result.preview)
  console.log(`\nBatch ${result.batchId}`)
  console.log(summarizeCounts(result.counts))
  app.store.close()
  return result.readyToSubmit ? 0 : 1
}

async function show(batchId?: string): Promise<number> {
  const app = await openApp()
  const id = batchId ?? app.store.latestBatch()?.id
  if (!id) {
    console.error("No batches exist yet.")
    app.store.close()
    return 1
  }
  const result = describeBatch(app, id)
  console.log(result.preview)
  console.log(`\nBatch ${result.batchId}`)
  console.log(summarizeCounts(result.counts))
  for (const item of app.store.listItems(id)) {
    if (item.zohoId) console.log(`  #${item.seq} Zoho ${item.zohoId}${item.verified ? " (verified)" : " (unverified)"} ${item.webUrl ?? ""}`)
  }
  app.store.close()
  return 0
}

async function submit(batchId?: string): Promise<number> {
  const app = await openApp({ requireCredentials: true })
  const id = batchId ?? app.store.latestBatch()?.id
  if (!id) {
    console.error("No batch to submit.")
    app.store.close()
    return 1
  }
  const report = await submitBatch(app, id)
  for (const item of report.items) {
    console.log(`#${item.seq} [${item.state}] ${item.subject}`)
    console.log(`    ${item.message}`)
    if (item.webUrl) console.log(`    ${item.webUrl}`)
  }
  console.log(`\n${summarizeCounts(report.counts)}`)
  for (const note of report.notes) console.log(`note: ${note}`)
  if (report.stopped) console.log(`\nBatch stopped (${report.stopped.category}): ${report.stopped.message}`)
  app.store.close()
  return report.stopped || (report.counts.failed ?? 0) > 0 || (report.counts.uncertain ?? 0) > 0 ? 1 : 0
}

async function reconcile(batchId?: string): Promise<number> {
  const app = await openApp({ requireCredentials: true })
  const id = batchId ?? app.store.latestBatch()?.id
  if (!id) {
    console.error("No batch to reconcile.")
    app.store.close()
    return 1
  }
  app.store.recoverStaleSubmitting(RECONCILE_STALE_MS)
  const uncertain = app.store.itemsInState(id, ["uncertain"])
  if (!uncertain.length) {
    console.log("No uncertain items in this batch.")
    app.store.close()
    return 0
  }
  let unresolved = 0
  for (const item of uncertain) {
    const outcome = await reconcileItem(app.client!, app.store, item)
    console.log(`#${item.seq} [${outcome.resolution}] ${item.subject}`)
    console.log(`    ${outcome.message}`)
    if (outcome.resolution !== "created") unresolved += 1
  }
  app.store.close()
  return unresolved ? 1 : 0
}

async function confirm(itemId?: string): Promise<number> {
  if (!itemId) {
    console.error("Usage: confirm <itemId>")
    return 2
  }
  const app = await openApp()
  const ok = app.store.confirmDistinct(itemId)
  console.log(ok ? `Item ${itemId} is now ready to submit.` : `Item ${itemId} was not flagged as a duplicate.`)
  app.store.close()
  return ok ? 0 : 1
}

async function purge(): Promise<number> {
  const app = await openApp()
  const changed = app.store.purgeOldRawText(app.config.retentionDays)
  console.log(`Purged raw text from ${changed} record(s) older than ${app.config.retentionDays} days.`)
  console.log("Deduplication fingerprints and Zoho IDs were preserved.")
  app.store.close()
  return 0
}

function summarizeCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([state, count]) => `${count} ${state}`)
  return parts.length ? parts.join(", ") : "no items"
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    if (err instanceof ConfigError || err instanceof ZohoError) {
      console.error(`\n${err.message}`)
    } else if (err && err.name === "ZodError" && Array.isArray(err.issues)) {
      console.error("\nThe input did not match the expected shape:")
      for (const issue of err.issues) {
        const where = issue.path?.length ? issue.path.join(".") : "(root)"
        console.error(`  - ${where}: ${issue.message}`)
      }
    } else {
      console.error(`\nUnexpected error: ${redactUnknown(err)}`)
    }
    process.exitCode = 1
  })
