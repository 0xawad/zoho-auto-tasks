import { openDatabase, type Db } from "./db.ts"
import { databaseFile, ensureDir } from "../config/paths.ts"
import path from "node:path"
import type { Attempt, BatchRecord, ItemRecord, ItemState, ResolvedItem, StatusIntent } from "../domain/types.ts"

export const SCHEMA_VERSION = 1

/**
 * How long an item may sit in 'submitting' before reconciliation treats it as
 * abandoned. Comfortably above the request timeout, so a reconcile run cannot
 * steal an item from a submission that is still genuinely in flight.
 */
export const RECONCILE_STALE_MS = 30_000

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS batches (
    id             TEXT PRIMARY KEY,
    created_at     TEXT NOT NULL,
    work_date      TEXT NOT NULL,
    timezone       TEXT NOT NULL,
    mode           TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    source_text    TEXT
  );

  CREATE TABLE IF NOT EXISTS items (
    id              TEXT PRIMARY KEY,
    batch_id        TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    source_ref      TEXT NOT NULL,
    subject         TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    client_label    TEXT,
    status_intent   TEXT NOT NULL,
    payload_json    TEXT NOT NULL,
    payload_hash    TEXT NOT NULL,
    fingerprint     TEXT NOT NULL,
    state           TEXT NOT NULL,
    zoho_id         TEXT,
    web_url         TEXT,
    verified        INTEGER NOT NULL DEFAULT 0,
    blocked_reasons TEXT NOT NULL DEFAULT '[]',
    error_json      TEXT,
    attempts_json   TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS items_batch_idx ON items(batch_id);
  CREATE INDEX IF NOT EXISTS items_fingerprint_idx ON items(fingerprint);
  CREATE UNIQUE INDEX IF NOT EXISTS items_zoho_idx ON items(zoho_id) WHERE zoho_id IS NOT NULL;
  `,
]

export class Store {
  private readonly db: Db

  private constructor(db: Db) {
    this.db = db
  }

  static async open(file: string = databaseFile()): Promise<Store> {
    if (file !== ":memory:") ensureDir(path.dirname(file))
    const db = await openDatabase(file)
    const store = new Store(db)
    store.migrate()
    return store
  }

  private migrate(): void {
    this.db.exec(MIGRATIONS[0]!)
    const current = this.db.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    if (!current) {
      this.db.run("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)])
      return
    }
    const version = Number(current.value)
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `State database schema version ${version} is newer than this build supports (${SCHEMA_VERSION}). ` +
          `Upgrade zoho-auto-tasks rather than downgrading the database.`,
      )
    }
  }

  close(): void {
    this.db.close()
  }

  /**
   * Persist the batch and every item before anything is sent. An item that was
   * never written locally must never be submitted.
   */
  createBatch(
    batch: BatchRecord,
    items: ResolvedItem[],
    opts: { duplicateWindowDays: number } = { duplicateWindowDays: 7 },
  ): void {
    const now = new Date().toISOString()
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO batches (id, created_at, work_date, timezone, mode, schema_version, source_text)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [batch.id, batch.createdAt, batch.workDate, batch.timezone, batch.mode, batch.schemaVersion, batch.sourceText],
      )
      for (const item of items) {
        const duplicate = this.findRecentCreatedByFingerprint(item.fingerprint, opts.duplicateWindowDays)
        let state: ItemState = item.blockedReasons.length ? "blocked" : "ready"
        const reasons = [...item.blockedReasons]
        if (duplicate && state === "ready") {
          state = "duplicate_skipped"
          reasons.push(
            `An equivalent task was already created on ${duplicate.createdAt.slice(0, 10)} ` +
              `(Zoho ID ${duplicate.zohoId ?? "unknown"}). Confirm it is distinct work to submit anyway.`,
          )
        }
        this.db.run(
          `INSERT INTO items (
             id, batch_id, seq, source_ref, subject, description, client_label, status_intent,
             payload_json, payload_hash, fingerprint, state, blocked_reasons, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.id,
            batch.id,
            item.seq,
            item.sourceRef,
            item.subject,
            item.description,
            item.clientLabel,
            item.statusIntent,
            JSON.stringify(item.payload),
            item.payloadHash,
            item.fingerprint,
            state,
            JSON.stringify(reasons),
            now,
            now,
          ],
        )
      }
    })
  }

  getBatch(batchId: string): BatchRecord | null {
    const row = this.db.get<any>("SELECT * FROM batches WHERE id = ?", [batchId])
    return row ? mapBatch(row) : null
  }

  latestBatch(): BatchRecord | null {
    const row = this.db.get<any>("SELECT * FROM batches ORDER BY created_at DESC LIMIT 1")
    return row ? mapBatch(row) : null
  }

  listItems(batchId: string): ItemRecord[] {
    return this.db.all<any>("SELECT * FROM items WHERE batch_id = ? ORDER BY seq", [batchId]).map(mapItem)
  }

  getItem(itemId: string): ItemRecord | null {
    const row = this.db.get<any>("SELECT * FROM items WHERE id = ?", [itemId])
    return row ? mapItem(row) : null
  }

  /**
   * Atomically take ownership of a ready item. Returns false if another
   * submitter already claimed it, which is what prevents duplicate dispatch.
   */
  claimItem(itemId: string): boolean {
    const result = this.db.run(
      "UPDATE items SET state = 'submitting', updated_at = ? WHERE id = ? AND state = 'ready'",
      [new Date().toISOString(), itemId],
    )
    return result.changes === 1
  }

  /** Release a claim without recording an outcome (e.g. batch stopped early). */
  releaseClaim(itemId: string): void {
    this.db.run("UPDATE items SET state = 'ready', updated_at = ? WHERE id = ? AND state = 'submitting'", [
      new Date().toISOString(),
      itemId,
    ])
  }

  recordCreated(itemId: string, zohoId: string, webUrl: string | null, verified: boolean): void {
    this.db.run(
      `UPDATE items SET state = 'created', zoho_id = ?, web_url = ?, verified = ?, error_json = NULL, updated_at = ?
       WHERE id = ?`,
      [zohoId, webUrl, verified ? 1 : 0, new Date().toISOString(), itemId],
    )
  }

  setVerified(itemId: string, verified: boolean, webUrl?: string | null): void {
    this.db.run("UPDATE items SET verified = ?, web_url = COALESCE(?, web_url), updated_at = ? WHERE id = ?", [
      verified ? 1 : 0,
      webUrl ?? null,
      new Date().toISOString(),
      itemId,
    ])
  }

  setState(itemId: string, state: ItemState, error: unknown = null): void {
    this.db.run("UPDATE items SET state = ?, error_json = ?, updated_at = ? WHERE id = ?", [
      state,
      error === null ? null : JSON.stringify(error),
      new Date().toISOString(),
      itemId,
    ])
  }

  appendAttempt(itemId: string, attempt: Attempt): void {
    const row = this.db.get<{ attempts_json: string }>("SELECT attempts_json FROM items WHERE id = ?", [itemId])
    const attempts: Attempt[] = row ? safeParse(row.attempts_json, []) : []
    attempts.push(attempt)
    // Keep the ledger bounded; the newest attempts are what matter for recovery.
    const trimmed = attempts.slice(-20)
    this.db.run("UPDATE items SET attempts_json = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(trimmed),
      new Date().toISOString(),
      itemId,
    ])
  }

  /** Allow the user to override a duplicate flag for genuinely distinct work. */
  confirmDistinct(itemId: string): boolean {
    const result = this.db.run(
      "UPDATE items SET state = 'ready', blocked_reasons = '[]', updated_at = ? WHERE id = ? AND state = 'duplicate_skipped'",
      [new Date().toISOString(), itemId],
    )
    return result.changes === 1
  }

  findRecentCreatedByFingerprint(
    fingerprint: string,
    windowDays: number,
  ): { id: string; zohoId: string | null; createdAt: string } | null {
    if (windowDays <= 0) return null
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
    const row = this.db.get<any>(
      `SELECT id, zoho_id, created_at FROM items
       WHERE fingerprint = ? AND state = 'created' AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
      [fingerprint, since],
    )
    return row ? { id: row.id, zohoId: row.zoho_id, createdAt: row.created_at } : null
  }

  /**
   * A process that died mid-submission leaves items stuck in 'submitting'.
   * Those become 'uncertain' - never 'ready' - because the create may have
   * landed in Zoho. Reconciliation, not replay, resolves them.
   */
  recoverStaleSubmitting(olderThanMs = 120_000): ItemRecord[] {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString()
    const stale = this.db
      .all<any>("SELECT * FROM items WHERE state = 'submitting' AND updated_at <= ?", [cutoff])
      .map(mapItem)
    for (const item of stale) {
      this.setState(item.id, "uncertain", {
        category: "interrupted",
        message:
          "The submitting process stopped before recording an outcome. The task may or may not exist in Zoho.",
      })
    }
    return stale
  }

  itemsInState(batchId: string, states: ItemState[]): ItemRecord[] {
    if (!states.length) return []
    const placeholders = states.map(() => "?").join(",")
    return this.db
      .all<any>(`SELECT * FROM items WHERE batch_id = ? AND state IN (${placeholders}) ORDER BY seq`, [
        batchId,
        ...states,
      ])
      .map(mapItem)
  }

  /**
   * Retention: drop raw source text and descriptions after the configured
   * period while keeping the deduplication fingerprints and Zoho IDs, so
   * duplicate protection survives the removal of the raw text.
   */
  purgeOldRawText(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    const batches = this.db.run("UPDATE batches SET source_text = NULL WHERE created_at < ? AND source_text IS NOT NULL", [
      cutoff,
    ])
    const items = this.db.run(
      `UPDATE items SET source_ref = '<purged>', description = '', payload_json = '{}'
       WHERE created_at < ? AND source_ref <> '<purged>'`,
      [cutoff],
    )
    return batches.changes + items.changes
  }
}

function safeParse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

function mapBatch(row: any): BatchRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    workDate: row.work_date,
    timezone: row.timezone,
    mode: row.mode,
    schemaVersion: row.schema_version,
    sourceText: row.source_text ?? null,
  }
}

function mapItem(row: any): ItemRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    seq: row.seq,
    sourceRef: row.source_ref,
    subject: row.subject,
    description: row.description ?? "",
    clientLabel: row.client_label ?? null,
    statusIntent: row.status_intent as StatusIntent,
    payloadJson: row.payload_json,
    payloadHash: row.payload_hash,
    fingerprint: row.fingerprint,
    state: row.state as ItemState,
    zohoId: row.zoho_id ?? null,
    webUrl: row.web_url ?? null,
    verified: Number(row.verified) === 1,
    blockedReasons: safeParse(row.blocked_reasons, [] as string[]),
    error: safeParse(row.error_json, null),
    attempts: safeParse(row.attempts_json, [] as Attempt[]),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
