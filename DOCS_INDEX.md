# ORBIT Documentation Index

Current as of 2026-09-29. Prefer updating these files over writing one-off status notes. Documents marked **point-in-time** record a moment and are deliberately not kept current; do not edit them to match today's code.

## Start here

| File | Purpose |
|---|---|
| `README.md` | Stack, setup, tests, deploy commands, how ORBIT runs itself, where docs live |
| `CLAUDE.md` | Operating model for an agent or new engineer: Convex topology, deploy path, the auth invariant, email rules, model policy, traps |
| `AGENTS.md` | Handoff brief for an agent continuing work on this tree |
| `STATUS.md` (IIH-internal, not published) | Current implementation status and open follow-ups |
| `ROADMAP.md` | What shipped and what remains |

## Operating

| File | Purpose |
|---|---|
| `docs/AUTOMATION_LOG.md` | The self-running portal: which human gates were removed, what replaced each, reviews and verification. Newest first |
| `docs/USER_STORY_MATRIX.md` | Per-role stories with the evidence that each works |
| `docs/TASK_PROGRAMME.md` (IIH-internal, not published) | How work reaches interns: weekly agent-written tasks, bank fallback, points, cadence, review |
| `LEVELS_SYSTEM.md` | Level ladder and how levels are computed |
| `DATA_IMPORT_NOTES.md` (IIH-internal, not published) | Bulk import of users from a spreadsheet |
| `docs/manual/README.md` | Building and publishing the role manuals (`npm run manual:publish`) |
| `scripts/agent/SUPPORT_FAQ.md` | The grounding text the agent uses to answer intern messages |
| `.claude/skills/deploy-orbit/SKILL.md` | Deploy skill: working credentials, the non-`git push` path, gotchas |
| `docs/sheet-mirror.gs` | Apps Script for the application-intake to Google Sheet mirror (the mirror cron is currently disabled) |
| `docs/templates/` | SIWES acceptance-letter directive and letter templates |

## Security

| File | Purpose |
|---|---|
| `SECURITY.md` | The security model: no RLS, function-level authz, MCP, secrets, backups |
| `MCP_CONNECTION_GUIDE.md` | How the ORBIT agent authenticates over MCP and what it can do |

## Product and design

| File | Purpose |
|---|---|
| `PRD.md`, `docs/ORBIT_2.0_PRD.md` (IIH-internal, not published) | Product requirements |
| `ORBIT_2_0_REQUIREMENTS.md` | SIWES and logbook requirements behind ORBIT 2.0 |
| `DESIGN_SYSTEM.md` | Brand, UI, layout and accessibility rules |
| `docs/TASK_BANK_DRAFT.md` | Early draft of candidate tasks built from public IIH material. Superseded in practice by `convex/lib/taskSeed.ts` |
| `docs/reference/` | Reference copies of source documents (the ORBIT 2.0 concept note) |

## Historical (point-in-time)

| File | What it records |
|---|---|
| `docs/CONVEX_MIGRATION.md` (IIH-internal, not published) | The Supabase to Convex migration: what moved, defects found, the cutover |
| `docs/HARDENING_CHANGE_NOTES.md` (IIH-internal, not published) | The August 2026 hardening pass, with how each claim was verified |
| `docs/PROD_VERIFICATION_2026-08-11.md` (IIH-internal, not published) | A production audit as of 11 August 2026; re-run its checks rather than trusting it |
| `FINDINGS_oxalpha.md` (IIH-internal, not published) | An external review's findings |
| `SECURITY_IMPLEMENTATION_SUMMARY.md` (IIH-internal, not published) | **Archived.** The 2025 Postgres/Supabase RLS pass; describes a system that no longer exists |
| `ORBIT_2_0_IMPLEMENTATION.md` | Implementation report for the ORBIT 2.0 SIWES build |
| `ORBIT_PLATFORM_CHANGES_FOR_UPDATED_CONCEPT_NOTE.md` | Platform changes tracked against the updated concept note |
| `OPEN_SOURCE_PLAN.md` (IIH-internal, not published) | Open-sourcing plan |
| `docs/superpowers/` | Feature plans and specs written before implementation (`plans/`, `specs/`) |

## Hygiene

- No local machine paths, private workspace structure or secrets in docs.
- Merge overlapping notes into the closest durable document; add a root doc only when it has an owner and recurring use.
- A doc describing retired infrastructure (Supabase, Netlify functions) is rewritten or marked archived at the top. An incorrect security or architecture doc is worse than none.
