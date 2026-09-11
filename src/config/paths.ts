import os from "node:os"
import path from "node:path"
import fs from "node:fs"

const APP = "zoho-auto-tasks"

function envHome(): string | null {
  const override = process.env.ZOHO_AUTO_TASKS_HOME
  return override && override.trim().length > 0 ? override : null
}

/** Directory holding config.json and secrets.json. */
export function configDir(): string {
  const override = envHome()
  if (override) return path.join(override, "config")
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), ".config")
  return path.join(base, APP)
}

/** Directory holding the state database, token cache and metadata cache. */
export function dataDir(): string {
  const override = envHome()
  if (override) return path.join(override, "data")
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), ".local", "share")
  return path.join(base, APP)
}

export function configFile(): string {
  return path.join(configDir(), "config.json")
}

export function secretsFile(): string {
  return path.join(configDir(), "secrets.json")
}

export function tokenCacheFile(): string {
  return path.join(dataDir(), "token-cache.json")
}

export function metadataCacheFile(): string {
  return path.join(dataDir(), "metadata.json")
}

export function databaseFile(): string {
  return path.join(dataDir(), "state.db")
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Write JSON with restrictive permissions, atomically. */
export function writeSecureJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
}

export function readJsonIfExists(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (err: any) {
    if (err && err.code === "ENOENT") return null
    throw err
  }
}
