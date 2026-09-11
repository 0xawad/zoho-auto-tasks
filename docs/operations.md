# Operations runbook

Recovery, credentials, retention and troubleshooting for zoho-auto-tasks.

## Where things live

| What | Path |
|---|---|
| Configuration | `~/.config/zoho-auto-tasks/config.json` |
| Credentials | `~/.config/zoho-auto-tasks/secrets.json` (mode 600) |
| State database | `~/.local/share/zoho-auto-tasks/state.db` |
| Access token cache | `~/.local/share/zoho-auto-tasks/token-cache.json` (mode 600) |
| Metadata cache | `~/.local/share/zoho-auto-tasks/metadata.json` |
| OpenCode agent | `~/.config/opencode/agents/daily-tasks.md` |
| OpenCode tools | `~/.config/opencode/tools/desk.ts` |

Set `ZOHO_AUTO_TASKS_HOME` to relocate all of the above, which is useful for testing
against a second portal without disturbing your real state.

## Item states

| State | Meaning | What to do |
|---|---|---|
| `draft` | Created but not validated | Nothing; transient |
| `blocked` | Local validation failed; nothing sent | Fix the draft or the config, prepare again |
| `ready` | Validated, eligible for submission | `submit` |
| `submitting` | Claimed by a submitter right now | Wait; if the process died it becomes `uncertain` |
| `created` | Zoho returned a task ID | Nothing |
| `failed` | Zoho definitively rejected it; no task exists | Correct and prepare a new batch |
| `uncertain` | The outcome is genuinely unknown | `reconcile`, then check Zoho manually if needed |
| `duplicate_skipped` | An equivalent task already exists | `confirm <itemId>` if it is distinct work |

`created` additionally carries a `verified` flag. Unverified means the ID exists but the
read-back failed, so the field values were never confirmed.

## Recovering from an interrupted run

If OpenCode, the CLI, or the machine dies mid-submission, items can be left in
`submitting`. They are **never** returned to `ready` automatically, because the create may
have reached Zoho.

```bash
node src/cli.ts show <batchId>       # see what is outstanding
node src/cli.ts reconcile <batchId>  # search Zoho for the missing tasks
```

Reconciliation searches by department, subject and creation-time window. Outcomes:

- **created** — the task was found; the ID is recorded and the item is resolved.
- **not_found** — no match. The create most likely did not land, but Zoho's search index
  can lag. Check the task list in Zoho before resubmitting.
- **ambiguous** — several tasks match. The tool refuses to guess. Decide manually.
- **unavailable** — the search itself failed. Retry when connectivity returns.

Items still `uncertain` after reconciliation are deliberately left alone. Resubmitting one
risks a duplicate; only you can decide.

Reconciliation ignores items claimed within the last 30 seconds so that it cannot steal an
item from a submission that is still in flight. Wait half a minute after a crash.

## Token rotation and revocation

The refresh token does not expire. Rotate it if it may have been exposed:

1. Revoke the old one:
   ```bash
   curl -X POST "https://accounts.zoho.eu/oauth/v2/token/revoke?token=OLD_REFRESH_TOKEN"
   ```
2. Generate a new self-client code and exchange it (see README).
3. Replace `refreshToken` in `secrets.json`.
4. Delete the cached access token so the next call refreshes cleanly:
   ```bash
   rm -f ~/.local/share/zoho-auto-tasks/token-cache.json
   ```

If the refresh token is revoked or invalid, writes stop immediately and the error tells you
to reconnect. It is never retried in a loop.

**Zoho throttles token requests to ten per ten minutes.** If you hit
`Access Denied … too many requests`, wait a few minutes. Normal operation refreshes about
once an hour, so hitting this means the token cache is being deleted or is unwritable.

## Rate limits

Zoho Desk bills API *credits* daily and caps *concurrent* calls, rather than rate-limiting
per minute. A daily batch costs roughly one credit per task plus one per verification.

Two different 429s, handled differently:

- `THRESHOLD_EXCEEDED` — the portal's daily credit allowance is gone. The batch stops.
  Nothing will succeed until the allowance resets at midnight in the data-centre timezone.
- `TOO_MANY_REQUESTS` — concurrency limit. Retried automatically with backoff.

## Scope and permission errors

| Error | Meaning | Fix |
|---|---|---|
| `SCOPE_MISMATCH` | The token lacks a scope for that call | Regenerate the refresh token with the full scope string in the README |
| `OAUTH_ORG_MISMATCH` | `orgId` does not match the token's portal | Correct `orgId`, or regenerate the token against the intended portal |
| `INVALID_DATA` | Zoho rejected specific fields | The message names the fields; usually a stale department, owner or picklist value |

After a schema or picklist error, refresh the metadata cache rather than editing mappings
blindly:

```bash
node src/cli.ts discover
```

## Tasks created as Completed

Creating a task with a Completed status is undocumented by Zoho. Every created task is read
back, and if the intent was a completed work session but Zoho reports the task as open, the
result says so.

To have the tool close it with a follow-up update, set in your config:

```json
"statusFollowUp": { "patchIfNotClosed": true }
```

and add `Desk.activities.tasks.UPDATE` to your token's scopes. This is opt-in because it is
a second write that needs an extra permission.

## Retention and backup

Raw summaries and descriptions are kept for `retentionDays` (default 30):

```bash
node src/cli.ts purge
```

Purging removes the raw text but keeps fingerprints and Zoho IDs, so duplicate protection
survives. Run it from cron if you want it automatic.

Back up the state database if duplicate history matters:

```bash
sqlite3 ~/.local/share/zoho-auto-tasks/state.db ".backup /path/to/backup.db"
```

**Deleting the database weakens duplicate protection.** The tool can no longer tell that a
task was already created and will happily create it again. The database is also the only
record of uncertain items awaiting reconciliation.

## Uninstalling

```bash
rm ~/.config/opencode/agents/daily-tasks.md
rm ~/.config/opencode/tools/desk.ts
```

Optionally remove `~/.config/zoho-auto-tasks` and `~/.local/share/zoho-auto-tasks`, and
revoke the refresh token.

**Uninstalling does not delete anything in Zoho.** Tasks already created stay created; this
tool never deletes a Zoho record, and never rolls back a partial batch.

## Upgrading OpenCode

The agent and tools are loaded from `~/.config/opencode/`. After an OpenCode upgrade,
confirm the tools still load:

```bash
opencode run --agent daily-tasks "list your available tools"
```

Custom tool and agent loading were verified against OpenCode 1.18.30 with its embedded Bun
1.3 runtime. If a future version changes the tool API, `opencode/tools/desk.ts` is the only
file that needs adjusting — the core in `src/` has no OpenCode dependency.
