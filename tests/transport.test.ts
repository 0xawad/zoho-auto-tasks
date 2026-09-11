import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { DeskClient } from "../src/zoho/client.ts"
import { TokenManager } from "../src/zoho/oauth.ts"
import { ZohoError, categorize, parseRetryAfter } from "../src/zoho/errors.ts"
import { assertAllowedApiDomain, resolveDeskBase } from "../src/config/regions.ts"
import { redact, registerSecret } from "../src/util/redact.ts"
import { baseConfig, tempHome } from "./helpers.ts"
import path from "node:path"

const SECRETS = { clientId: "1000.abc", clientSecret: "shhh-client-secret", refreshToken: "1000.refresh.token" }

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  })
}

function tokenCachePath(): string {
  return path.join(tempHome(), "token-cache.json")
}

function fixedTokens(cacheFile: string, fetchImpl: any): TokenManager {
  return new TokenManager(baseConfig(), SECRETS, { fetchImpl, cacheFile })
}

test("categorises the two distinct meanings of HTTP 429", () => {
  assert.equal(categorize(429, "THRESHOLD_EXCEEDED"), "credits", "daily credit exhaustion")
  assert.equal(categorize(429, "TOO_MANY_REQUESTS"), "concurrency", "concurrency limit")
  assert.equal(categorize(429, null), "concurrency")
})

test("categorises auth, scope and validation failures distinctly", () => {
  assert.equal(categorize(401, "UNAUTHORIZED"), "auth")
  assert.equal(categorize(403, "SCOPE_MISMATCH"), "config")
  assert.equal(categorize(403, "OAUTH_ORG_MISMATCH"), "config")
  assert.equal(categorize(422, "INVALID_DATA"), "validation")
  assert.equal(categorize(500, null), "server")
})

test("only ambiguous categories mark a write outcome unknown", () => {
  const unknown = (category: any) => new ZohoError({ message: "x", category }).writeOutcomeUnknown
  assert.equal(unknown("network"), true)
  assert.equal(unknown("server"), true)
  assert.equal(unknown("validation"), false, "a definitive rejection created nothing")
  assert.equal(unknown("config"), false)
})

test("parses Retry-After in both documented forms", () => {
  assert.equal(parseRetryAfter("34"), 34)
  assert.equal(parseRetryAfter(null), null)
  assert.equal(parseRetryAfter("garbage"), null)
})

test("rejects an api_domain outside the known Desk host allowlist", () => {
  assert.equal(assertAllowedApiDomain("https://desk.zoho.eu"), "https://desk.zoho.eu")
  assert.throws(() => assertAllowedApiDomain("https://evil.example.com"), /allowlist/)
  assert.throws(() => assertAllowedApiDomain("http://desk.zoho.eu"), /non-https/)
})

test("caches the access token instead of refreshing per request", async () => {
  let refreshes = 0
  const cacheFile = tokenCachePath()
  const fetchImpl = async (url: string) => {
    if (url.includes("/oauth/v2/token")) {
      refreshes += 1
      return jsonResponse({ access_token: "1000.access.token", expires_in: 3600, api_domain: "https://desk.zoho.eu" })
    }
    return jsonResponse({ data: [] })
  }
  const tokens = fixedTokens(cacheFile, fetchImpl)
  const client = new DeskClient(baseConfig(), tokens, { fetchImpl })

  await client.request("/departments")
  await client.request("/departments")
  await client.request("/departments")

  assert.equal(refreshes, 1, "Zoho throttles token requests, so one refresh must serve many calls")
  const mode = fs.statSync(cacheFile).mode & 0o777
  assert.equal(mode, 0o600, "the token cache must not be world readable")
})

test("refreshes once after a definitive 401 and then retries", async () => {
  let refreshes = 0
  let apiCalls = 0
  const fetchImpl = async (url: string) => {
    if (url.includes("/oauth/v2/token")) {
      refreshes += 1
      return jsonResponse({ access_token: `token-${refreshes}`, expires_in: 3600, api_domain: "https://desk.zoho.eu" })
    }
    apiCalls += 1
    if (apiCalls === 1) return jsonResponse({ errorCode: "INVALID_OAUTH", message: "bad token" }, { status: 401 })
    return jsonResponse({ data: [{ id: "1" }] })
  }
  const tokens = fixedTokens(tokenCachePath(), fetchImpl)
  const client = new DeskClient(baseConfig(), tokens, { fetchImpl })

  const result = await client.request<any>("/departments")
  assert.equal(refreshes, 2)
  assert.equal(apiCalls, 2)
  assert.deepEqual(result.data.data, [{ id: "1" }])
})

test("does not loop indefinitely when the refreshed token is still rejected", async () => {
  let apiCalls = 0
  const fetchImpl = async (url: string) => {
    if (url.includes("/oauth/v2/token")) {
      return jsonResponse({ access_token: "token", expires_in: 3600, api_domain: "https://desk.zoho.eu" })
    }
    apiCalls += 1
    return jsonResponse({ errorCode: "INVALID_OAUTH", message: "nope" }, { status: 401 })
  }
  const tokens = fixedTokens(tokenCachePath(), fetchImpl)
  const client = new DeskClient(baseConfig(), tokens, { fetchImpl })

  await assert.rejects(() => client.request("/departments"), /failed/)
  assert.equal(apiCalls, 2, "exactly one refresh-and-retry")
})

test("never retries a write, even on a retryable category", async () => {
  let creates = 0
  const fetchImpl = async (url: string, init: any) => {
    if (url.includes("/oauth/v2/token")) {
      return jsonResponse({ access_token: "token", expires_in: 3600, api_domain: "https://desk.zoho.eu" })
    }
    creates += 1
    return jsonResponse({ errorCode: "INTERNAL_SERVER_ERROR", message: "boom" }, { status: 500 })
  }
  const tokens = fixedTokens(tokenCachePath(), fetchImpl)
  const client = new DeskClient(baseConfig(), tokens, { fetchImpl })

  await assert.rejects(() => client.request("/tasks", { method: "POST", body: {}, isWrite: true }))
  assert.equal(creates, 1, "an ambiguous write must be reconciled, never replayed")
})

test("retries a read on a transient failure", async () => {
  let reads = 0
  const fetchImpl = async (url: string) => {
    if (url.includes("/oauth/v2/token")) {
      return jsonResponse({ access_token: "token", expires_in: 3600, api_domain: "https://desk.zoho.eu" })
    }
    reads += 1
    if (reads < 3) return jsonResponse({ errorCode: "TOO_MANY_REQUESTS", message: "slow down" }, { status: 429 })
    return jsonResponse({ data: [] })
  }
  const tokens = fixedTokens(tokenCachePath(), fetchImpl)
  const client = new DeskClient(baseConfig(), tokens, { fetchImpl, sleep: async () => {} })

  await client.request("/departments")
  assert.equal(reads, 3)
})

test("stops immediately when the daily credit allowance is exhausted", async () => {
  let reads = 0
  const fetchImpl = async (url: string) => {
    if (url.includes("/oauth/v2/token")) {
      return jsonResponse({ access_token: "token", expires_in: 3600, api_domain: "https://desk.zoho.eu" })
    }
    reads += 1
    return jsonResponse({ errorCode: "THRESHOLD_EXCEEDED", message: "no credits" }, { status: 429, headers: { "Retry-After": "34" } })
  }
  const tokens = fixedTokens(tokenCachePath(), fetchImpl)
  const client = new DeskClient(baseConfig(), tokens, { fetchImpl, sleep: async () => {} })

  const err = await client.request("/departments").catch((e) => e)
  assert.equal(err.category, "credits")
  assert.equal(err.retryAfterSeconds, 34)
  assert.equal(reads, 1, "retrying a credit exhaustion is pointless")
  assert.ok(err.stopsBatch)
})

test("gives an actionable message for a revoked refresh token and stops writing", async () => {
  const fetchImpl = async () => jsonResponse({ error: "invalid_grant" })
  const tokens = fixedTokens(tokenCachePath(), fetchImpl)
  const err = await tokens.getAccessToken().catch((e) => e)
  assert.ok(err instanceof ZohoError)
  assert.equal(err.category, "config")
  assert.match(err.message, /revoked/)
  assert.match(err.message, /api-console\.zoho\.com/)
})

test("redacts tokens and secrets from any surfaced text", () => {
  registerSecret("shhh-client-secret")
  const text =
    'Authorization: Zoho-oauthtoken 1000.deadbeefcafe1234.abcdef9876543210 and {"refresh_token":"1000.aaaa.bbbb"} and shhh-client-secret'
  const safe = redact(text)
  assert.ok(!safe.includes("deadbeefcafe1234"))
  assert.ok(!safe.includes("shhh-client-secret"))
  assert.ok(!safe.includes("1000.aaaa.bbbb"))
})

test("a network failure surfaces without leaking the token in the message", async () => {
  const fetchImpl = async (url: string) => {
    if (url.includes("/oauth/v2/token")) {
      return jsonResponse({ access_token: "1000.secret.value", expires_in: 3600, api_domain: "https://desk.zoho.eu" })
    }
    throw new Error("connect ECONNREFUSED using token 1000.secret.value")
  }
  const tokens = fixedTokens(tokenCachePath(), fetchImpl)
  const client = new DeskClient(baseConfig(), tokens, { fetchImpl, sleep: async () => {} })

  const err = await client.request("/departments").catch((e) => e)
  assert.equal(err.category, "network")
  assert.ok(!err.message.includes("1000.secret.value"), "the token must never appear in an error")
})

test("maps the generic Zoho APIs domain to the matching Desk host", () => {
  // Zoho's token response returns www.zohoapis.com, which is not where the
  // Desk API lives. It identifies the data centre, nothing more.
  assert.equal(resolveDeskBase("https://www.zohoapis.com", "https://desk.zoho.eu").base, "https://desk.zoho.com")
  assert.equal(resolveDeskBase("https://www.zohoapis.eu", "https://desk.zoho.com").base, "https://desk.zoho.eu")
})

test("accepts an api_domain that is already a Desk host", () => {
  assert.equal(resolveDeskBase("https://desk.zoho.in", "https://desk.zoho.com").base, "https://desk.zoho.in")
})

test("falls back to the configured Desk host instead of stranding a valid token", () => {
  // Refusing outright would throw away a refresh token that is perfectly good.
  const result = resolveDeskBase("https://unexpected.example.com", "https://desk.zoho.com")
  assert.equal(result.base, "https://desk.zoho.com")
  assert.match(result.note!, /unrecognised api_domain/)
  assert.match(result.note!, /no credentials were sent/)

  assert.equal(resolveDeskBase(null, "https://desk.zoho.com").base, "https://desk.zoho.com")
  assert.equal(resolveDeskBase("http://desk.zoho.com", "https://desk.zoho.eu").base, "https://desk.zoho.eu")
})

test("the token manager stores the Desk host, not the APIs domain", async () => {
  const fetchImpl = async () =>
    jsonResponse({ access_token: "tok", expires_in: 3600, api_domain: "https://www.zohoapis.com" })
  const tokens = fixedTokens(tokenCachePath(), fetchImpl)
  const { apiDomain } = await tokens.getAccessToken()
  assert.equal(apiDomain, "https://desk.zoho.com")
})
