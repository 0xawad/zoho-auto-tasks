# Quick Start

## 1. Clone and install

```bash
git clone https://github.com/0xawad/zoho-auto-tasks.git
cd zoho-auto-tasks
npm install
npm run install-agent
```

This installs the `daily-tasks` OpenCode agent and creates the restricted configuration file:

```text
~/.config/zoho-auto-tasks/.env
```

## 2. Configure `.env`

Set these values in `~/.config/zoho-auto-tasks/.env`:

```dotenv
ZOHO_REGION=us
ZOHO_TIMEZONE=Etc/UTC
ZOHO_OWNER_EMAIL=you@example.com
ZOHO_DEPARTMENT_NAME=Support
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
ZOHO_REFRESH_TOKEN=...
```

Use `ZOHO_DEPARTMENT_ID` instead of the department name when available. Set `ZOHO_ORG_ID`
when the token can access more than one organization. The template documents optional work
session, status, priority, retry, and retention settings.

## 3. Obtain a refresh token, if needed

Create a Zoho self-client at <https://api-console.zoho.com> with:

```text
Desk.activities.tasks.CREATE,Desk.activities.tasks.READ,Desk.search.READ,Desk.basic.READ,Desk.fields.READ,Desk.layouts.READ
```

Generate an authorization code and run:

```bash
node src/cli.ts connect
```

Then run setup. It resolves the email and department to Zoho IDs, validates the tenant, and
creates the derived local cache:

```bash
npm run setup
node src/cli.ts doctor
```

## 4. Use the agent

In OpenCode, select the `daily-tasks` agent and paste a work summary. It creates a preview
first and only submits tasks after approval while `ZOHO_SUBMISSION_MODE=preview`.

```text
Acme: Investigated the login failure; it remained unresolved.
```

The agent drafts the task, shows its exact Zoho payload, and reports the created task ID and
verification result after submission.
