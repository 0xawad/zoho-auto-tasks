/**
 * Zoho data-centre hosts.
 *
 * Accounts hosts: https://www.zoho.com/accounts/protocol/oauth/multi-dc.html
 *                 (live registry: https://accounts.zoho.com/oauth/serverinfo)
 * Desk hosts:     https://desk.zoho.com/DeskAPIDocument#DataCenterEndpoints
 *
 * The Desk host here is only a fallback for display and validation. The
 * authoritative value is `api_domain` from the OAuth token response, which
 * Zoho explicitly instructs clients to use instead of a hardcoded region.
 */
export const REGIONS = {
  us: { accounts: "https://accounts.zoho.com", desk: "https://desk.zoho.com", apis: "https://www.zohoapis.com" },
  eu: { accounts: "https://accounts.zoho.eu", desk: "https://desk.zoho.eu", apis: "https://www.zohoapis.eu" },
  in: { accounts: "https://accounts.zoho.in", desk: "https://desk.zoho.in", apis: "https://www.zohoapis.in" },
  au: {
    accounts: "https://accounts.zoho.com.au",
    desk: "https://desk.zoho.com.au",
    apis: "https://www.zohoapis.com.au",
  },
  jp: { accounts: "https://accounts.zoho.jp", desk: "https://desk.zoho.jp", apis: "https://www.zohoapis.jp" },
  uk: { accounts: "https://accounts.zoho.uk", desk: "https://desk.zoho.uk", apis: "https://www.zohoapis.uk" },
  ca: {
    accounts: "https://accounts.zohocloud.ca",
    desk: "https://desk.zohocloud.ca",
    apis: "https://www.zohoapis.ca",
  },
  sa: { accounts: "https://accounts.zoho.sa", desk: "https://desk.zoho.sa", apis: "https://www.zohoapis.sa" },
  sg: { accounts: "https://accounts.zoho.sg", desk: "https://desk.zoho.sg", apis: "https://www.zohoapis.sg" },
  ae: { accounts: "https://accounts.zoho.ae", desk: "https://desk.zoho.ae", apis: "https://www.zohoapis.ae" },
} as const

export type RegionCode = keyof typeof REGIONS

export const REGION_CODES = Object.keys(REGIONS) as RegionCode[]

/** Hosts an api_domain is allowed to point at. Anything else is rejected. */
const ALLOWED_DESK_HOSTS = new Set(
  Object.values(REGIONS)
    .map((r) => new URL(r.desk).host)
    .concat(["desk.zoho.com.cn"]),
)

/** Generic Zoho APIs domains, mapped to the Desk host of the same data centre. */
const APIS_HOST_TO_DESK = new Map(
  Object.values(REGIONS).map((r) => [new URL(r.apis).host, r.desk] as const),
)

export type DeskBaseResolution = {
  base: string
  note: string | null
}

/**
 * Work out which Desk host to call, given the api_domain from a token response.
 *
 * Zoho instructs clients not to hardcode a regional URL, but the api_domain it
 * returns is the generic Zoho APIs domain (for example www.zohoapis.com), which
 * is not where the Desk API lives. So api_domain is used to identify the data
 * centre, and the Desk host for that centre is used as the base.
 *
 * This never throws. An unrecognised api_domain is ignored in favour of the
 * configured region, because refusing outright would strand a valid token.
 */
export function resolveDeskBase(apiDomain: string | null | undefined, fallbackDesk: string): DeskBaseResolution {
  if (!apiDomain) return { base: fallbackDesk, note: null }

  let url: URL
  try {
    url = new URL(apiDomain)
  } catch {
    return { base: fallbackDesk, note: `Ignored an unparseable api_domain: ${JSON.stringify(apiDomain)}` }
  }
  if (url.protocol !== "https:") {
    return { base: fallbackDesk, note: `Ignored a non-https api_domain: ${url.protocol}//${url.host}` }
  }
  if (ALLOWED_DESK_HOSTS.has(url.host)) {
    return { base: `https://${url.host}`, note: null }
  }

  const mapped = APIS_HOST_TO_DESK.get(url.host)
  if (mapped) {
    return {
      base: mapped,
      note: mapped === fallbackDesk ? null : `api_domain ${url.host} indicates the Desk host ${mapped}`,
    }
  }

  return {
    base: fallbackDesk,
    note:
      `Zoho returned an unrecognised api_domain (${url.host}). Using the configured region's ` +
      `Desk host ${fallbackDesk} instead; no credentials were sent to the unknown host.`,
  }
}

/**
 * Strict check used where an explicit Desk host is required. Prevents an
 * unexpected token response from redirecting writes to an arbitrary host.
 */
export function assertAllowedApiDomain(apiDomain: string): string {
  let url: URL
  try {
    url = new URL(apiDomain)
  } catch {
    throw new Error(`Zoho returned an unparseable api_domain: ${JSON.stringify(apiDomain)}`)
  }
  if (url.protocol !== "https:") {
    throw new Error(`Zoho returned a non-https api_domain: ${url.protocol}//${url.host}`)
  }
  if (!ALLOWED_DESK_HOSTS.has(url.host)) {
    throw new Error(
      `Zoho returned an api_domain outside the known Desk host allowlist: ${url.host}. ` +
        `Refusing to send credentials there.`,
    )
  }
  return `https://${url.host}`
}
