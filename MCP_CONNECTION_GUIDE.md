# ORBIT MCP Server — Connection Guide

The ORBIT MCP (Model Context Protocol) server lets an AI client work with the ORBIT
platform: users, streams, tasks, submissions, leaderboard, feed, messaging,
notifications and settings.

It talks to no database. It calls the ORBIT Convex deployment's public functions
— the same ones the web app calls — holding an ordinary 15-minute ORBIT session.
See [Security model](#security-model) before deploying.

## Two ways the ORBIT Agent acts

- **MCP sessions (this guide).** A person or tool authenticates through
  `mcp.authenticate` with a credential secret and acts as the ORBIT Agent
  account through the public functions, under the ordinary role checks. Tasks
  created this way become **proposals**, not published tasks.
- **The unattended runner** (`scripts/agent/cycle.sh`, on the agent's Mac mini).
  It does its work — marking, admissions screening, logbook review, task
  writing, helpdesk replies, cohort rollover — by calling **internal** Convex
  functions with `npx convex run` under **deployment credentials**. It never
  uses MCP, holds no MCP secret and mints no session. Its decisions are
  attributed to the same ORBIT Agent account, with `agent.`-prefixed audit
  actions. See `SECURITY.md` ("The unattended agent").

Nothing below applies to the runner.

---

## Prerequisites

- Node.js 20+
- The ORBIT Convex deployment URL
- A credential secret (`MCP_SECRET_<NAME>`, set on that deployment — see below)
- The bound ORBIT account must be an active `admin`/`super_admin` with MCP access
  enabled (Admin > Users)

---

## Installation

```bash
cd mcp-server
npm install
npm run build
```

---

## Environment variables

The server takes exactly two:

| Variable | Required | Description |
|---|---|---|
| `ORBIT_CONVEX_URL` | Yes | Deployment URL, e.g. `https://your-dev-deployment.eu-west-1.convex.cloud` |
| `ORBIT_MCP_SECRET` | Yes | Must match one credential's `MCP_SECRET_<NAME>` on that deployment. Minimum 32 characters. |

And, on the **Convex deployment** (`npx convex env set ...`), one *named
credential* per client:

| Variable | Description |
|---|---|
| `MCP_CREDENTIALS` | Comma-separated roster of credential names, e.g. `CLAWDIA,FEMI`. A name not on this list is ignored even if its variables exist. |
| `MCP_SECRET_<NAME>` | That credential's shared secret. Generate with `openssl rand -hex 32`. |
| `MCP_ACTOR_<NAME>` | The ORBIT account that credential acts as, e.g. `orbit.agent@iih.ng` |

A roster entry with only half its pair set is skipped rather than falling back
to some other identity. `MCP_SERVER_SECRET` + `MCP_ACTOR_EMAIL` remain supported
as an unnamed `default` credential, for deployments configured before the roster.

**The roster is explicit because Convex's `process.env` does not enumerate**:
`Object.keys(process.env)` returns nothing there while `process.env[name]` works,
so a prefix scan for `MCP_SECRET_*` would find zero credentials and silently
disable every client.

The old `ORBIT_SUPABASE_*`, `ORBIT_MCP_USER_*` and `ORBIT_APP_URL` variables are
gone. The actor is chosen by the deployment, not the client — see
[Security model](#security-model).

---

## Running the server

```bash
cd mcp-server
ORBIT_CONVEX_URL=https://your-dev-deployment.eu-west-1.convex.cloud \
ORBIT_MCP_SECRET=your-secret \
node dist/index.js
```

It authenticates at startup and prints the bound account to stderr. If the secret
is wrong, or the account is inactive or has MCP access disabled, it exits rather
than starting and then failing on every call.

---

## Client configuration

### Claude Desktop — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "orbit": {
      "command": "node",
      "args": ["/absolute/path/to/orbit/mcp-server/dist/index.js"],
      "env": {
        "ORBIT_CONVEX_URL": "https://your-dev-deployment.eu-west-1.convex.cloud",
        "ORBIT_MCP_SECRET": "your-secret"
      }
    }
  }
}
```

### Cursor — `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "orbit": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/orbit/mcp-server",
      "env": {
        "ORBIT_CONVEX_URL": "https://your-dev-deployment.eu-west-1.convex.cloud",
        "ORBIT_MCP_SECRET": "your-secret"
      }
    }
  }
}
```

Running both at once is supported — a deployment holds up to 5 concurrent MCP
sessions.

---

## Available tools

### Users

| Tool | Description |
|---|---|
| `list_users` | Active users, optionally filtered by role or stream |
| `get_user` | Full admin view of one user (no secrets) |
| `update_user_role` | Replace a user's roles |

### Streams

| Tool | Description |
|---|---|
| `list_streams` | Active streams. `member_count` is derived, never a stored counter |
| `get_stream` | Stream details plus its active members |
| `create_stream` | Create a stream |

### Tasks and submissions

| Tool | Description |
|---|---|
| `list_tasks` | Tasks, optionally by stream |
| `get_task` | One task |
| `create_task` | Create a silent pending proposal. Participants are not notified at creation, though an eligible supervisor or admin may be alerted to review it. Publication and participant notifications happen later through supervisor approval or, when configured, approval-window auto-publication. `notify_members` remains accepted for compatibility but has no effect on an MCP proposal. The deadline is optional; when omitted, ORBIT uses the cadence deadline for the current programme week while meaningful working time remains, otherwise the next week. |
| `update_task` | Update a task |
| `list_submissions` | Submissions by task, user and/or status |
| `score_submission` | Approve/reject/request changes. **Approving with a score awards the points**, updates the level, re-checks badges and notifies — in one transaction. Re-scoring pays the difference. |

### Leaderboard

| Tool | Description |
|---|---|
| `get_leaderboard` | Rankings for `overall`, `weekly` (rolling 7 days) or `monthly` (rolling 30) |

### Feed, chat and messaging

| Tool | Description |
|---|---|
| `post_to_feed` | Post to the activity feed |
| `reply_to_post` | Reply to a post |
| `post_stream_announcement` | Announcement in a stream chat |
| `check_mentions` | Posts and replies mentioning the actor in a time window |
| `send_direct_message` | DM a member — exactly one notification and one email |
| `list_agent_messages` | The actor's inbox, newest first |
| `reply_to_direct_message` | Reply, threaded to the original |
| `mark_message_read` | Mark one received message read, clearing its notification |

### Notifications, email, settings

| Tool | Description |
|---|---|
| `send_notification` | In-app notification. `action_url` must be an app-relative path |
| `queue_email_alert` | Queue a plain-text email. The address comes from the user record |
| `get_admin_settings` | All admin settings |
| `update_setting` | Update an existing setting. Unknown keys are rejected |

### Resources

| Resource | URI | Description |
|---|---|---|
| Platform Stats | `orbit://stats` | Active users, streams, tasks; pending submissions |

---

## IDs

Tools accept either a Convex id or a **pre-migration Postgres uuid**, resolved
through `legacyId`, so old `/tasks/<uuid>` links and notes keep working. That
layer goes away when `legacyId` is dropped.

---

## Security model

The v1 server held the Supabase service role key, which bypassed RLS on a
database shared with four other applications, and reimplemented trigger logic
badly (`score_submission` awarded zero points; `create_task` notified every
member three times). v2 holds no database credential.

- **The secret buys one thing**: a 15-minute session on one named ORBIT account.
  Everything after that goes through the same public functions, and the same
  `requireAdmin` / `requireModerator` / stream-membership / rate-limit checks, as
  a browser.
- **The actor is chosen by the deployment** (`MCP_ACTOR_<NAME>`), never by the
  client. Otherwise the secret would be a "become any admin" credential rather
  than a "become the agent" one.
- **Account state is re-checked on every exchange** — active, not deleted, MCP
  enabled, still an admin. v1 checked once at startup, so disabling an account
  changed nothing until someone restarted the process.
- **Revocation is immediate.** Turning MCP access off in Admin > Users deletes
  that account's live MCP sessions and does not touch anyone's browser session.
  `mcp.revokeAllSessions` kills every MCP session on the deployment, for use if
  the secret leaks.
- **Demotion revokes too.** Removing a user's admin role clears `mcpEnabled` and
  drops their MCP sessions.
- **Every write is audited**, including denials, with the actor taken from the
  session rather than from the client.

### Known limits

- An MCP session token **is** a full admin session token for its 15 minutes.
  Treat the secret as an admin credential.
- **The audit row is a second call.** If a write succeeds and the audit write then
  fails, the action happened without a record (a warning goes to stderr). Making
  that atomic means auditing inside each Convex mutation.
- **The agent reads member-written text** through `list_agent_messages` and
  `check_mentions`, and holds admin tools. An LLM cannot reliably separate
  "content I was asked to look at" from "instructions", so treat anything the
  agent does in response to member content as attributable to that member, not to
  the admin account the audit log names. `queue_email_alert` deliberately does
  **not** accept raw HTML for this reason. (The unattended runner avoids this by
  giving its model calls no tools at all; an MCP client holds admin tools.)

---

## Verifying a deployment

```bash
cd mcp-server && npm run build
ORBIT_CONVEX_URL=... ORBIT_MCP_SECRET=... node scripts/verify-live.mjs
```

Spawns the real server, exercises all 25 tools, and asserts each effect
separately against the database. **It writes real data** — a temporary
super_admin, an intern, a stream, tasks, notifications and emails — and refuses
to run against anything but the dev deployment unless
`ORBIT_VERIFY_ALLOW_NONDEV=yes`.

---

## The ORBIT Agent account

Every MCP credential resolves to **one shared platform account**, not to the
person or agent holding the credential:

| Field | Value |
|---|---|
| Name | ORBIT Agent |
| Email | `orbit.agent@iih.ng` |
| Role | `admin` |
| MCP access | Enabled |

`agent-a@example.org` and `agent-b@example.org` were the original per-agent accounts.
**Both are deactivated and neither can sign in.** The agents that used to be
those accounts now orchestrate the ORBIT Agent instead of acting as themselves.

`admin`, deliberately, not `super_admin`. The agent creates and edits content and
manages users; it does not trash accounts, read raw email bodies, or change
credential settings. Those stay with a human super admin.

### Who did what

The credential NAME is recorded, so a shared account still produces an
attributable audit trail. `mcp.authenticate` stores the matched slug on the
session as `mcpCredential`, and `recordAudit` copies it into
`metadata.credential` on every write — so an audit row reads "the ORBIT Agent,
via the CLAWDIA credential", and revoking one credential does not disturb the
others.

`mcp.authenticate` compares the presented secret against every configured
credential with no early exit, so the time it takes does not reveal which
credential was closest.

### Granting super_admin

Neither the agent, a plain `admin`, nor a super_admin can grant or revoke it:
`users.adminSetRoles` refuses the transition in both directions whoever asks
(reasoning in `SECURITY.md`). The stripping guard matters as much as the granting
one — demoting the owner would otherwise disable every other guard
(`adminSetActive`, `adminTrashUser`, `adminResetPassword`, `adminSetMcpAccess`)
with nothing able to undo it. A super_admin's other roles still edit normally.

The one route is deliberately awkward:

1. Add a temporary `internalMutation` that patches the row.
2. `npx convex deploy` it.
3. `npx convex run --prod <file>:<fn>` — internal functions need **deployment
   credentials**, which is owner-level database access; no session, MCP
   credential or HTTP route reaches them.
4. Delete the file, redeploy, and verify with `npx convex run` that the name no
   longer resolves.

Write an `auditLogs` row from the mutation saying it happened out of band and
why; a one-shot file created and deleted between deploys leaves nothing in git.

**What does NOT work, so nobody tries it twice:** pointing a temporary MCP
credential at the super admin's account. `mcp.authenticate` requires
`mcpEnabled` on the target user, and setting that flag is itself super-admin
only. It is circular by construction.
