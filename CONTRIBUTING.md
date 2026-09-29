# Contributing to ORBIT

ORBIT is maintained by [Ilorin Innovation Hub](https://iih.ng) and runs IIH's own programmes in production, so changes are reviewed with that in mind. Contributions from other organisations running ORBIT are welcome.

## Before you start

- **Bugs:** open an issue with what you did, what you expected and what happened. Screenshots help; personal data in them does not — please blur it.
- **Features:** open an issue first to discuss it. Changes that make ORBIT easier for other organisations to adopt (configuration, timezones, translations, programme types) are especially welcome.
- **Security problems:** do not open a public issue — see [SECURITY.md](SECURITY.md#reporting-a-vulnerability).

## Making a change

1. Fork, branch from `main`, and follow [SELF_HOSTING.md](SELF_HOSTING.md) to get a development deployment.
2. Read [CLAUDE.md](CLAUDE.md) — it is the fast path to how the code is organised and the invariants it keeps. Two matter most:
   - **Every public Convex function takes a `token` and resolves it** through `requireUser` / `requireAdmin` / `requireModerator`. `src/test/unit/convex-authz-surface.test.ts` fails the build otherwise; adding an exemption is a deliberate, reviewed change.
   - **Automation belongs in internal functions**, never public ones.
3. Keep the change focused. Match the surrounding code's style — including its habit of explaining *why* in comments.
4. Run the checks before opening a pull request:
   ```bash
   npm run typecheck && npm test && npm run lint && npm run build
   python3 -m unittest discover -s scripts/agent -p 'test_*.py'
   ```
   Add tests for bug fixes and non-trivial logic.
5. Open a pull request describing the problem, the change, and how you verified it.

## What is unlikely to be accepted

- Changes that weaken authorisation, remove a test's teeth, or add public functions that skip the token check.
- Large rewrites or dependency churn without a prior issue.
- Organisation-specific customisations that belong in your own fork (your task bank, letterhead, tracks).

## Licensing of contributions

ORBIT is licensed under the [GNU Affero General Public License v3.0](LICENSE). By submitting a contribution you agree that it is licensed under the AGPL-3.0, and that Ilorin Innovation Hub may also distribute it under other terms as part of a commercial edition of ORBIT (see the roadmap). You keep the copyright in your contribution. If that does not work for you, say so in your pull request before it is merged.

## Conduct

Be respectful and constructive. Harassment, discrimination and personal attacks are not tolerated in issues, pull requests or any other project space; maintainers may remove content and block participants who ignore this. Report conduct concerns to the maintainers privately (see [SECURITY.md](SECURITY.md#reporting-a-vulnerability) for the contact).
