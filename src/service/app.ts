import { loadConfig, loadSecrets, type Config } from "../config/config.ts"
import { metadataCacheFile, readJsonIfExists, writeSecureJson } from "../config/paths.ts"
import { Store } from "../state/store.ts"
import { TokenManager } from "../zoho/oauth.ts"
import { DeskClient } from "../zoho/client.ts"
import type { TenantMetadata } from "../zoho/metadata.ts"

/**
 * Wiring. Credentials are loaded here and never leave this layer: the OpenCode
 * tool adapter receives an App, not secrets, and no code path returns a token
 * to the model.
 */
export type App = {
  config: Config
  store: Store
  metadata: TenantMetadata | null
  /** Present only when credentials are configured. */
  client: DeskClient | null
  tokens: TokenManager | null
}

export function loadMetadataCache(): TenantMetadata | null {
  return readJsonIfExists(metadataCacheFile()) as TenantMetadata | null
}

export function saveMetadataCache(metadata: TenantMetadata): void {
  writeSecureJson(metadataCacheFile(), metadata)
}

export type OpenAppOptions = {
  /** Fail if credentials are missing, rather than returning a null client. */
  requireCredentials?: boolean
  databaseFile?: string
}

export async function openApp(opts: OpenAppOptions = {}): Promise<App> {
  const config = loadConfig()
  const store = await Store.open(opts.databaseFile)
  const metadata = loadMetadataCache()

  let client: DeskClient | null = null
  let tokens: TokenManager | null = null
  try {
    const secrets = loadSecrets()
    tokens = new TokenManager(config, secrets)
    client = new DeskClient(config, tokens)
  } catch (err) {
    if (opts.requireCredentials) throw err
  }

  return { config, store, metadata, client, tokens }
}
