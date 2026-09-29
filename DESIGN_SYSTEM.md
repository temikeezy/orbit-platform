# ORBIT Design System

ORBIT should feel like a dependable daily operations platform with a warm community layer. It is not a marketing dashboard. The product supports interns, SIWES students, supervisors, department leads, moderators, and admins who return often to log work, review submissions, track attendance, send messages, and export reports.

## Brand Direction

- Use the ORBIT logo as the visual anchor: bright IIH green, black wordmark, white/silver orbital band.
- Green should guide action and state, not dominate the whole interface.
- Prefer calm operational neutrals, compact layouts, and clear status hierarchy.
- BuddyBoss-style community clarity is a useful reference for profiles, cohorts, activity, groups, messages, and badges, but ORBIT should remain more disciplined and task-oriented.

## ORBIT Control Visual System

The applied visual direction is **ORBIT Control**: a mission-operations interface for internship, SIWES, stream, and supervisor workflows. It should feel more like a focused control room than a generic SaaS template.

- Use a dark ink app shell for orientation and identity.
- Use cool green-tinted canvas, white surfaces, and firm grid lines instead of generic slate dashboards or warm cream landing-page styling.
- Use IIH green as the activation color, paired with restrained sky, amber, and violet for secondary operational states.
- Use the IBM Plex family throughout: Sans for interface text and Mono for data, references, points, dates, and codes.
- Keep cards and panels at 8px radius with one-pixel borders and modest shadows.
- Prefer telemetry-style admin cards, tables, tabs, and queues over decorative metric cards.
- Public pages should feel like official IIH programme intake, not a marketing landing page.

## Design Principles

1. **Daily work first**: each screen should make the user's next operational action obvious.
2. **Community without clutter**: avatars, cohorts, streams, badges, and activity should add context without becoming decorative noise.
3. **IIH-specific language**: use labels like SIWES log, supervisor sign-off, stream task, department shadowing, orientation checklist, weekly summary, cohort, and moderation queue.
4. **Dense but calm**: support repeated admin and supervisor use without oversized panels or low-information cards.
5. **Status is visual and textual**: pair badges, colors, progress, and timelines with readable labels.
6. **No fake flourish**: every icon, image, panel, or chart must communicate identity, hierarchy, status, or navigation.

## Tokens

| Token | Value | Use |
|---|---:|---|
| Brand green | `#16A464` | Primary actions, active navigation, progress, success accents |
| Ink | `#102018` | App shell, primary text, high-emphasis anchors |
| Graphite | `#33423B` | Secondary headings and labels |
| Canvas | `#EDF2F0` | App background with a subtle green undertone |
| Surface | `#FFFFFF` | Main content surfaces |
| Subtle | `#F7FAF8` | Low-emphasis bands, empty states, table headers |
| Line | `#D8E2DD` | Borders, dividers, table lines |
| Muted text | `#66736D` | Secondary copy and metadata |
| Mint | `#DFF4EA` | Success/supportive action backgrounds |
| Sky | `#256D85` | Neutral information and streams |
| Amber | `#A06A18` | Pending, exceptions, needs review |
| Violet | `#57518F` | Recognition, cohorts, secondary grouping |
| Danger | `#B7443E` | Rejected, overdue, destructive actions |

Existing Tailwind `iih` tokens remain for compatibility. New work should prefer `orbit.*` tokens and use green as a signal color, not as the whole palette.

## Typography

- Use `IBM Plex Sans` for page titles, body text, labels, tables, forms, and navigation.
- Use `IBM Plex Mono` for operational data: reference codes, matric numbers, dates, points, streak counts, and metric values.
- Page titles: `24-30px`, semibold/bold.
- Section titles: `16-20px`, semibold.
- Card/list titles: `14-16px`, semibold.
- Body text: `14px` default.
- Metadata/table text: `12-13px`.
- Avoid oversized display text except for rare orientation/welcome moments.
- Letter spacing should remain normal.

## Shape, Elevation, and Spacing

- Panels, cards, inputs, menus, and modals should use `6-8px` radius.
- Small status badges may use pills.
- Prefer one-pixel borders over heavy shadows.
- Use shadows only for overlays, menus, modals, and meaningful elevation.
- Main shell padding: `16px` mobile, `24px` desktop.
- Panel padding: `12-20px` for dense operational screens, up to `24px` for forms.

## App Shell

- Desktop: persistent sidebar with a restrained active state, ideally a green rail or subtle green background.
- Mobile: drawer or bottom navigation with stable touch targets.
- Top bar should support title/breadcrumb context, search, notifications, messages, and profile access.
- Role-aware navigation should separate intern, supervisor, department lead, and admin tasks.

Recommended groups:

- Dashboard
- Community
- Streams & Tasks
- SIWES
- Attendance
- Messages
- Reports
- Admin / Moderation

## Layout Patterns

- Use full-width page sections, tabs, tables, lists, split panes, and toolbars.
- Avoid nested cards.
- Use table/list layouts for operational data: interns, submissions, logs, attendance, reports.
- Use repeated cards only for member/activity/task items where cards improve scanning.
- Use right-side drawers for detail previews where possible.
- Tables should collapse into structured rows/cards on mobile.

## Component Rules

- Buttons: primary, secondary, ghost, danger, icon. Use icons for common actions when they improve scanning.
- Forms: labels are required; inputs must have visible focus states and clear helper/error text.
- Status badges: use consistent labels and colors for draft, pending, submitted, approved/signed off, changes requested, overdue, excused, and absent.
- Empty states: avoid emojis and generic copy. Use concise, role-specific text and a concrete next action.
- Activity feed: concise operational events, for example "Amina submitted Week 4 summary" or "Supervisor requested changes".
- Profiles: combine identity, role, stream/cohort, SIWES details, progress, recent work, and earned recognition.
- Admin tables: filters, search, date ranges, bulk actions, and export controls should be near the data they affect.

## SIWES-Specific Patterns

Intern surfaces should make the following obvious:

- Today's SIWES log status
- Physical-day attendance state
- Weekly summary status
- Supervisor feedback and requested changes
- Export/print path for university logbook evidence

Supervisor surfaces should prioritize:

- Pending sign-offs and submitted logs
- Overdue/missing logs
- Attendance exceptions
- Department shadowing context
- Fast approve/request-changes flows with required comments when needed

Admin surfaces should prioritize:

- Cohort health
- Active departments and supervisors
- Intern assignment
- Compliance reports
- Reminder fan-out
- Export controls

## Accessibility and Responsiveness

- Meet WCAG AA contrast.
- Keep visible focus states.
- Do not rely on color alone for status.
- Ensure tabs, dialogs, forms, menus, and drawers are keyboard navigable.
- Use labels for inputs and readable table headers.
- Touch targets should be at least `40px` on mobile.
- Long names, stream titles, and report labels must wrap or truncate cleanly.

## UI Cleanup Checklist

- No nested cards.
- No giant decorative dashboard cards.
- No generic SaaS gradient backgrounds.
- No decorative blobs or orbs.
- Green is an accent/action color, not the whole palette.
- Every panel/list item has a concrete purpose.
- Statuses use consistent labels and colors.
- Empty states use ORBIT-specific next actions.
- Admin and supervisor workflows are faster than before.
- Intern workflows make today's obligations obvious.
- SIWES logs, weekly summaries, attendance, and sign-off states remain prominent.
- Build, typecheck, tests, and lint must pass before release.
