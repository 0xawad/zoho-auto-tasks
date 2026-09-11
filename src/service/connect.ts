import readline from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { REGIONS, REGION_CODES, resolveDeskBase, type RegionCode } from "../config/regions.ts"
import { secretsFile, writeSecureJson, readJsonIfExists, configFile } from "../config/paths.ts"
import { registerSecret, redact } from "../util/redact.ts"

/**
 * Guided one-time credential setup.
 *
 * A self-client authorization code is valid for about three minutes and can be
 * used once, so this exchanges it immediately and writes the resulting refresh
 * token to the restricted secrets file. The code is read from stdin rather than
 * from a command-line argument, so it never reaches the shell history or the
 * process list.
 */
export async function connect(): Promise<number> {
  // Non-interactive mode: four lines on stdin (region, clientId, clientSecret,
  // code). Kept off the command line so nothing lands in shell history or ps.
  if (!stdin.isTTY) {
    const lines = (await readAll()).split("\n").map((l) => l.trim())
    const [region, clientId, clientSecret, code] = lines
    if (!region || !clientId || !clientSecret || !code) {
      console.error(
        "Non-interactive connect expects four lines on stdin: region, clientId, clientSecret, code.",
      )
      return 2
    }
    return await exchange(region, clientId, clientSecret, code)
  }

  const rl = readline.createInterface({ input: stdin, output: stdout })

  try {
    const existingConfig = readJsonIfExists(configFile()) as { region?: string } | null
    const defaultRegion = existingConfig?.region

    console.log(`
Zoho self-client setup
----------------------
Before continuing, at https://api-console.zoho.com:

  1. Add Client -> Self Client (or open your existing one)
  2. Open the "Generate Code" tab
  3. Paste this scope string:

     Desk.activities.tasks.CREATE,Desk.activities.tasks.READ,Desk.search.READ,Desk.basic.READ,Desk.fields.READ,Desk.layouts.READ

  4. Choose your Desk portal, set the duration, and generate the code

The code expires in about three minutes, so have it ready.
`)

    const regionInput = (
      await rl.question(`Data centre [${REGION_CODES.join(", ")}]${defaultRegion ? ` (${defaultRegion})` : ""}: `)
    )
      .trim()
      .toLowerCase()
    const region = (regionInput || defaultRegion) as RegionCode
    if (!REGION_CODES.includes(region)) {
      console.error(`\n"${region}" is not a known Zoho data centre.`)
      return 2
    }

    const configuredClientId = process.env.ZOHO_CLIENT_ID?.trim()
    const configuredClientSecret = process.env.ZOHO_CLIENT_SECRET?.trim()
    const clientId =
      (await rl.question(`Client ID${configuredClientId ? " (from .env available)" : ""}: `)).trim() ||
      configuredClientId ||
      ""
    const clientSecret =
      (await rl.question(`Client Secret${configuredClientSecret ? " (from .env available)" : ""}: `)).trim() ||
      configuredClientSecret ||
      ""
    const code = (await rl.question("Generated code: ")).trim()

    if (!clientId || !clientSecret || !code) {
      console.error("\nAll three values are required.")
      return 2
    }
    registerSecret(clientSecret)
    registerSecret(code)

    return await exchange(region, clientId, clientSecret, code, defaultRegion)
  } finally {
    rl.close()
  }
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

/** Exchange a self-client authorization code for a refresh token. */
async function exchange(
  regionInput: string,
  clientId: string,
  clientSecret: string,
  code: string,
  configuredRegion?: string,
): Promise<number> {
  const region = regionInput.trim().toLowerCase() as RegionCode
  if (!REGION_CODES.includes(region)) {
    console.error(`"${regionInput}" is not a known Zoho data centre. Expected one of: ${REGION_CODES.join(", ")}`)
    return 2
  }
  registerSecret(clientSecret)
  registerSecret(code)

  const accounts = REGIONS[region].accounts
  console.log(`Exchanging the code at ${accounts} …`)

  const response = await fetch(`${accounts}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
    signal: AbortSignal.timeout(30_000),
  })

  const payload: any = await response.json().catch(() => null)
  if (!payload) {
    console.error(`Zoho returned an unreadable response (HTTP ${response.status}).`)
    return 1
  }

  // Zoho reports failures with HTTP 200 and an `error` field.
  if (payload.error) {
    console.error(`\nZoho rejected the exchange: ${payload.error}`)
    console.error(explain(String(payload.error)))
    return 1
  }
  if (typeof payload.refresh_token !== "string") {
    console.error(
      `\nZoho returned an access token but no refresh token. ` +
        `Regenerate the code, making sure a duration is selected, and try again.`,
    )
    return 1
  }

  registerSecret(payload.refresh_token)
  registerSecret(payload.access_token)

  // Persist first. The authorization code is single-use, so anything that can
  // fail after the exchange must not run before the refresh token is safe on
  // disk - otherwise a late failure burns the code and loses the token.
  writeSecureJson(secretsFile(), { clientId, clientSecret, refreshToken: payload.refresh_token })

  const resolved = resolveDeskBase(payload.api_domain, REGIONS[region].desk)
  if (resolved.note) console.log(`\nNote: ${redact(resolved.note)}`)
  const apiDomain = resolved.base

  console.log(`
Saved to ${secretsFile()} (mode 600).

  Data centre:   ${region}
  API domain:    ${apiDomain}
  Refresh token: stored, not printed

The refresh token does not expire. Access tokens are cached separately and
refreshed automatically.

Next:
  node src/cli.ts doctor      # verify connectivity
  node src/cli.ts discover    # read-only: find your department and agent IDs
`)

  if (configuredRegion && configuredRegion !== region) {
    console.log(`Note: ${configFile()} says region "${configuredRegion}". Update it to "${region}".`)
  }
  return 0
}

function explain(error: string): string {
  switch (error) {
    case "invalid_code":
      return "The code was already used or has expired. Generate a fresh one and retry within three minutes."
    case "invalid_client":
      return "The client ID or secret is wrong, or the client belongs to a different data centre."
    case "invalid_client_secret":
      return "The client secret does not match the client ID."
    default:
      return "Check the client details and scopes in the Zoho API console."
  }
}
