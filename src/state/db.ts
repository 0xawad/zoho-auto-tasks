/**
 * SQLite access that works in both runtimes we care about:
 *  - Bun 1.3 (OpenCode executes custom tools inside its embedded Bun runtime)
 *  - Node 22 (the CLI and the test suite)
 *
 * Both drivers expose nearly the same surface; this narrows them to the few
 * operations the state store actually needs.
 */

export type Db = {
  exec(sql: string): void
  run(sql: string, params?: unknown[]): { changes: number }
  all<T = any>(sql: string, params?: unknown[]): T[]
  get<T = any>(sql: string, params?: unknown[]): T | undefined
  transaction<T>(fn: () => T): T
  close(): void
}

function toCount(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0)
}

export async function openDatabase(file: string): Promise<Db> {
  const isBun = typeof (globalThis as any).Bun !== "undefined"

  if (isBun) {
    const { Database } = await import("bun:sqlite")
    const db = new Database(file, { create: true })
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA foreign_keys = ON")
    db.exec("PRAGMA busy_timeout = 5000")
    return {
      exec: (sql) => db.exec(sql),
      run: (sql, params = []) => ({ changes: toCount(db.prepare(sql).run(...(params as any[])).changes) }),
      all: (sql, params = []) => db.prepare(sql).all(...(params as any[])) as any[],
      get: (sql, params = []) => db.prepare(sql).get(...(params as any[])) as any,
      transaction: (fn) => db.transaction(fn)(),
      close: () => db.close(),
    }
  }

  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => ({ changes: toCount(db.prepare(sql).run(...(params as any[])).changes) }),
    all: (sql, params = []) => db.prepare(sql).all(...(params as any[])) as any[],
    get: (sql, params = []) => db.prepare(sql).get(...(params as any[])) as any,
    transaction: (fn) => {
      db.exec("BEGIN")
      try {
        const result = fn()
        db.exec("COMMIT")
        return result
      } catch (err) {
        try {
          db.exec("ROLLBACK")
        } catch {
          /* rollback of an already-failed transaction is best effort */
        }
        throw err
      }
    },
    close: () => db.close(),
  }
}
