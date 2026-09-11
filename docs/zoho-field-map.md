# Zoho Desk Tasks — verified field map

Status: discovery gate **mostly closed** (10 Sep 2026). Everything below is sourced.
Tenant-specific values (org ID, department ID, owner ID, picklist values, custom fields)
are still **unknown** and must be discovered at runtime via the metadata endpoints in §6.

Primary sources:

- HTML reference: `https://desk.zoho.com/DeskAPIDocument` (server-rendered, ~11.5 MB; deep
  anchors such as `#Tasks_Createtask`, `#Tasks_Listtasks`, `#Search_SearchTasks`,
  `#OAuthScopes`, `#Errors`, `#APICredits`, `#DataCenterEndpoints` are stable)
- Official OpenAPI 3.1 spec: `https://github.com/zoho/zohodesk-oas` —
  `v1.0/Task.json`, `v1.0/Common.json`, `v1.0/Search.json`, `v1.0/Field.json`
- Zoho Accounts OAuth: `https://www.zoho.com/accounts/protocol/oauth/...`

Where the HTML doc and the OAS disagree, the HTML doc wins (the OAS README states the
specs omit application-specific business logic).

---

## 1. Create task

`POST {api_domain}/api/v1/tasks`

Headers:

- `Authorization: Zoho-oauthtoken {access_token}` (`Bearer {token}` also documented)
- `orgId: {org_id}` — optional in principle (the token is org-bound) but send it; a
  mismatch yields `OAUTH_ORG_MISMATCH` (403), which is a useful safety check.

Request body (`#Tasks_Createtask`):

| Field | Type | Required | Limit / notes |
|---|---|---|---|
| `departmentId` | long | **yes** | pattern `[0-9]+`, cannot be null |
| `subject` | string | **yes** | max 300 chars |
| `description` | string | no | max 65535 chars |
| `ownerId` | long | no | assignee; may be null |
| `ticketId` | long | no | association, cannot be null once set |
| `contactId` | long | no | association, may be null |
| `teamId` | long | no | |
| `dueDate` | timestamp | no | UTC only, see §4 |
| `status` | string | no | max 120; free-form portal picklist, no API enum |
| `priority` | string | no | max 120; free-form portal picklist, no API enum |
| `category` | string | no | max 120 |
| `cf` | object | no | custom fields, see §3 |
| `customFields` | list | no | **deprecated**, use `cf` |
| `reminder` | array | no | `ABSOLUTE` (`reminderTime`) or `RELATIVE` (`relativeReminderInMin`) + `alertType` |
| `layoutId` | long | no | in OAS only, absent from HTML attribute table |

Numeric IDs may be sent as JSON strings (Zoho's own example does this).

Success: **HTTP 200** with a bare task object (not wrapped in `data`), including `id`,
`webUrl`, `createdTime`, `statusType`. `webUrl` is returned by the API — use it, never
construct links by hand.

Fields present in responses only: `statusType` (`Open` | `Closed`), `completedTime`,
`activityTime`, `startTime`, `createdTime`, `modifiedTime`, `creatorId`, `modifiedBy`,
`isSpam`, `isTrashed`, `webUrl`.

### Consequences for the plan

- **There is no `accountId` on a task.** Client/account association is only reachable
  transitively through `contact.accountId`. Client identity must live in the subject /
  description, or in a custom field, unless contacts are mapped.
- **There is no writable start/end time.** `startTime` is read-only and absent from the
  create schema; `endTime` does not exist at all. The plan's `startAt` / `endAt` fields
  cannot be delivered on Tasks. Duration/time tracking belongs to Time Entries
  (out of scope) — this must be dropped or explicitly deferred.
- **There is no "work date" field.** `dueDate` is the only writable date. A daily-log
  work date must map to `dueDate`, to a custom field, or to text — a product decision.

## 2. Status and priority

No API-level enum; both are per-portal, per-layout picklists.

Default out-of-the-box values (Zoho KB, UI documentation — not the API reference):

- Status: `Not Started`, `Deferred`, `In Progress`, `Waiting on Someone`, `Canceled`, `Completed`
- Priority: `Highest`, `High`, `Normal`, `Low`, `Lowest`

`Completed` is a **system-defined** status; a custom status with the same label does not
close the task. Closing stamps `completedTime`. Marking Completed may require profile
permission. Reopening resets status to `Not Started`.

Use the response-side `statusType` (`Open`/`Closed`) to reason about closure rather than
string-matching a possibly renamed status.

**UNVERIFIED:** whether `POST` with `status: "Completed"` actually closes the task and
populates `completedTime`. The KB only ever describes *updating* an existing task. Nothing
forbids it on create. Must be tested empirically in Phase 5; if it fails, a second
`PATCH /api/v1/tasks/{id}` becomes a required, separately tracked step.

## 3. Custom fields

`cf` is a JSON **object** (the HTML doc's "list" is wrong), keyed by field API name,
values are strings with **max length 100**:

```json
"cf": { "cf_permanentaddress": "Menlo Park, California" }
```

Task custom fields are discoverable via `GET /api/v1/fields?module=tasks`.

This is the correct home for a correlation token (see §5) and possibly for the work date —
both subject to the tenant actually having such fields defined.

## 4. Date and time format

The OAS regex for writable timestamps requires `yyyy-MM-ddTHH:mm:ss[.SSS]Z` — the literal
trailing `Z` is **mandatory**; `+03:00`-style offsets are not accepted; the literal `null`
is allowed.

Applies to `dueDate` (and `reminderTime`). Search ranges use the same format.

Practical rule: resolve everything in `Asia/Beirut`, convert to UTC for transport, and
render back in local time in previews and results.

**UNVERIFIED (inferred from regex, not prose):** rejection of non-`Z` offsets.

## 5. Read-back, search, reconciliation

- `GET /api/v1/tasks/{id}` — `include=assignee,tickets,contacts,teams,creator`
- `GET /api/v1/tasks` — `departmentId`, `assignee`, `isCompleted`, `from`, `limit` (1–100),
  `sortBy` (`dueDate|createdTime|modifiedTime|subject|status|priority|category`, `-` = desc),
  plus OAS-only `fields`, `filters`, `filterId`
- `GET /api/v1/tasks/search` — `subject` (wildcard), `_all`, `departmentId`, `status`,
  `priority`, `assigneeId`, `createdTimeRange`, `modifiedTimeRange`, `dueDateRange`,
  `customField1..10` in the form `customField1=<FieldApiName>:<value>` (exact match),
  `sortBy` (`relevance|modifiedTime|createdTime`). Returns `{ data, count }`.
- `GET /api/v1/tickets/{ticket_id}/tasks`
- Avoid `GET /api/v1/tasks/count` — costs 50 credits per call.

**Reconciliation recipe for an uncertain create:**
`GET /api/v1/tasks/search?departmentId=…&createdTimeRange=<t0>,<t1>&subject=<subject>&limit=100&sortBy=-createdTime`,
matched on subject + createdTime. Exact and far more reliable if a correlation token is
written into a task custom field and searched via `customField1=<apiName>:<token>`.

**There is no idempotency key.** Zero occurrences of "idempoten*" in the entire API
documentation or OAS. No client-supplied ID on create. Exactly-once is impossible;
reconcile-by-search is the only mechanism.

Discrepancy: search `from` max is 4999 (HTML doc) vs 999 (OAS). Assume 999.

## 6. Metadata endpoints

| Purpose | Endpoint |
|---|---|
| Organizations (no orgId header needed) | `GET /api/v1/organizations` |
| Orgs reachable by this token | `GET /api/v1/accessibleOrganizations` |
| Departments | `GET /api/v1/departments` (`limit` 0–200) |
| My departments | `GET /api/v1/myDepartments` |
| Agents | `GET /api/v1/agents` (`status=ACTIVE`, `departmentIds`, `limit` 0–200) |
| Current agent | `GET /api/v1/agents/me` |
| Task fields incl. custom | `GET /api/v1/fields?module=tasks` |
| Task layouts | `GET /api/v1/layouts?module=tasks` |
| Layout as my profile sees it (`isMandatory`, `maxLength`, `type`, `apiName`) | `GET /api/v1/myForm?layoutId={id}` |
| Picklist values for a field in a layout | `GET /api/v1/layouts/{layoutId}/fields/{fieldId}/value` |

The layout/field endpoints are how the real `status` / `priority` / `category` values and
the real mandatory-field set for this tenant get discovered. Do not hardcode.

## 7. OAuth

- Auth: `GET {accounts_server}/oauth/v2/auth`
- Token / refresh: `POST {accounts_server}/oauth/v2/token`
- Accounts servers (live registry: `https://accounts.zoho.com/oauth/serverinfo`):
  us `accounts.zoho.com`, eu `accounts.zoho.eu`, in `accounts.zoho.in`,
  au `accounts.zoho.com.au`, jp `accounts.zoho.jp`, uk `accounts.zoho.uk`,
  ca `accounts.zohocloud.ca`, sa `accounts.zoho.sa`, sg `accounts.zoho.sg`,
  ae `accounts.zoho.ae`
- Desk API bases: `desk.zoho.com|.eu|.in|.com.au|.jp|.uk?|zohocloud.ca|.sa|.sg|.ae|.com.cn`.
  **Never hardcode**: use `api_domain` from the token response (Zoho's own instruction).

Scopes — two parallel families exist. Task endpoints in the HTML doc only ever cite
`Desk.activities.*`; the OAS accepts either. Use the `activities` family:

```
Desk.activities.tasks.CREATE,Desk.activities.tasks.READ,Desk.search.READ,
Desk.basic.READ,Desk.fields.READ,Desk.layouts.READ
```

(`Desk.basic.READ` covers organizations + departments + agents. Add
`Desk.activities.tasks.UPDATE` only if the Completed-on-create test fails.)

Flow: **self-client** is the right fit for a personal integration — generate an
authorization code in the API console (valid 3 min), exchange it once for a refresh token.
No redirect URI needed.

Token lifecycle:

- Access token lives **3600 s**; response also returns `api_domain`.
- Refresh returns a new access token and **no** new refresh token.
- Refresh tokens **do not expire** but can be revoked.
- Limits: max 10 active access tokens per refresh token; **max 10 token requests per 10
  minutes** (→ `Access Denied` / "too many requests"); max 20 refresh tokens per user per
  client.

**Therefore the access token must be cached durably (on disk, restricted permissions) with
an expiry margin and shared across invocations.** Refreshing per process would hit the
10-per-10-minutes throttle quickly.

Auth error codes: `UNAUTHORIZED`, `INVALID_OAUTH`, `SCOPE_MISMATCH`, `OAUTH_ORG_MISMATCH`.

## 8. Limits and errors

Zoho Desk uses **daily API credits + concurrency**, not per-minute rate limits.

- Credits/day by edition: Free 5 000 · Express 25 000 + 100/user · Standard 50 000 + 250/user ·
  Professional 75 000 + 500/user · Enterprise 100 000 + 1 000/user. Reset at 00:00 DC time.
- Concurrency: 5 (Free) → 25 (Enterprise) simultaneous calls.
- Costs: create task 1 · get task 1 · update 1 · list 3 · search 3 (1 with unique ID) ·
  `tasks/count` 50. A daily batch of ~10 tasks is negligible.
- Headers: `X-Rate-Limit-Request-Weight-v3`, `X-Rate-Limit-Remaining-v3`, and `Retry-After`
  (**only** on daily-credit exhaustion).

Two distinct 429s — branch on `errorCode`, not on the status:

- `THRESHOLD_EXCEEDED` — daily credits gone; honour `Retry-After`, effectively stop for the day.
- `TOO_MANY_REQUESTS` — concurrency exceeded; reduce parallelism, retry shortly. No `Retry-After`.

Status codes: 200, 201, 204, 400, 401, 403, 404, 405, 413, 415, 422, 429, 500.

`INVALID_DATA` (422) returns per-field detail with JSON-Pointer field names and
`errorType` ∈ `invalid | duplicate | missing`:

```json
{"errorCode":"INVALID_DATA","message":"…","errors":[{"fieldName":"/departmentId","errorType":"invalid"}]}
```

This maps cleanly onto per-item "definitive validation rejection" handling.

Doc convention worth honouring: "Always ignore undocumented fields or enum values present
in the API response" — response fields are dynamic due to profile-level field filtering.

---

## Open items (tenant / product decisions)

1. Work date has no home field — decide `dueDate` vs custom field vs description text.
2. Completed-on-create behaviour — empirical test required.
3. Whether a correlation custom field can be created in the tenant (enables exact-match
   reconciliation instead of fuzzy subject matching).
4. Real picklist values for status/priority, real mandatory fields, department ID, owner
   (agent) ID, org ID, data-centre region.
5. Whether client names map to Desk contacts (enabling `contactId`) or stay as text.

---

## Tenant validation notes

These findings came from a live validation portal. Tenant names, IDs, task names, URLs, and
custom-field API names are intentionally omitted because they are not portable configuration.

### Completed-on-create is resolved: it works

Read-back confirmed that a task created with a `Completed` status closed without a follow-up
update. Therefore
`Desk.activities.tasks.UPDATE` is not required, and `statusFollowUp.patchIfNotClosed` can
stay disabled. The read-back check remains in place to catch a future change in behaviour.

### Picklists are not readable through the API in this portal

`GET /fields?module=tasks` returns `status`, `priority` and `category` as `Picklist` type
with an empty `allowedValues`. `GET /layouts/{id}/fields/{fieldId}/value` returns `null`,
and `GET /myForm` returns HTTP 422. Values are therefore derived by sampling recent tasks.

Observed in use: status `Completed`, `In Progress`; priority `Critical`, `High`,
`Informational`, `Low`, `Medium`, `Normal`. Note the priorities are a customised set, not
Zoho's documented defaults. No `Not Started` was observed, so the `planned` status intent
is intentionally left unmapped rather than guessed.

### A portal can use custom fields for work-session timestamps

The generic Task API has no writable start or end time. A portal may define custom DateTime and
percentage fields for them, which can be configured in `.env`:

| API name | Type | Label |
|---|---|---|
| `cf_start_date_time` | DateTime | Start Date and Time |
| `cf_end_date_time` | DateTime | End Date and Time |
| `cf_percentage_of_completion` | Percent | Percentage of Completion |

DateTime custom fields accept the same UTC format as `dueDate`
(`2026-09-10T06:00:00.000Z`). The percentage field takes a numeric string (`"100"`).

Choose `dueDate`, a verified custom field, or no work-date placement according to the portal's
own workflow. Do not assume that any field name shown here exists in another portal.

### Other tenant facts

- `GET /agents/me` may return 404 in some portals; `GET /agents/{id}` works.
- `orgId` must be omitted rather than sent as a placeholder: a non-numeric value produces an
  opaque HTTP 500 on every endpoint except `/organizations`.
- Task `webUrl` can use a custom portal domain, another reason to use the returned URL rather
  than constructing one.
