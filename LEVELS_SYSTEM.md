# ORBIT Levels

A four-level ladder recognises how much an intern has contributed. A level is a pure function of total points.

## The ladder

The ladder is data: rows in the `levels` table, editable by admins under Admin, Levels. These are the values the in-app orientation page and manual describe; the table in the deployment is authoritative.

| Level | Name | Points required | Meaning |
|---|---|---|---|
| 1 | Orbit Entry | 0 | Start: updates, tasks, community |
| 2 | Active Orbit | 100 | Regular task participation |
| 3 | Event Orbit (Ilorin) | 300 | Volunteer pool for on-ground events in Ilorin |
| 4 | Orbit Stars | 600 | Top contributors: spotlight and priority pathways |

Each row also carries a description, an icon emoji and a colour, all editable.

## How a level is computed

- `levelForPoints` (`convex/levels.ts`) takes the highest level whose `pointsRequired` is at most the total. Level 1 is the floor.
- `awardPoints` (`convex/lib/points.ts`) is the single place points are awarded. In one transaction it writes the `pointsLedger` row, updates `users.totalPoints` and `users.currentLevel`, and, on an increase only, schedules the level-up notification. There is no database trigger.
- Corrections (`recomputeUserPoints`, withdrawing a mark) can move a level **down**; nobody is told they lost a level.
- Level-ups are announced in-app only. They queue no email, so a bulk marking pass cannot mail anyone about levels.
- The display progress (`levels.infoForPoints`) is computed from the ladder, not from `currentLevel`, so a stale stored value cannot make the UI disagree with the ledger.
- The server keeps the ladder monotonic: creating or editing a level is refused if its threshold would fall below the level beneath it or above the level above it, and level numbers are unique.
- **Scores belong to interns.** `awardPoints` returns zero for staff accounts, so supervisors never gain points, levels or leaderboard rank.

## Points

- A task is worth 1 to 20 points, enforced server-side (`docs/TASK_PROGRAMME.md` (IIH-internal, not published)). A submission cannot score above its task's value.
- Other source: badge bonus points.

## Event Orbit is not gated in code

The intended rule is that level 3 is open only to members of an Event Stream, with everyone else passing from level 2 to level 4. **Nothing enforces this.** Admin, Settings stores an `event_stream_id`, but no backend code reads it, and `levelForPoints` looks at points alone, so every intern who reaches 300 points reaches level 3. Treat Event Stream membership as a selection convention for the volunteer pool, or implement the gate (it would have to live in `levelForPoints` and its callers). The free-text `location` on the user profile is what staff use to pick Ilorin-based volunteers.

## Orbit Stars

Orbit Stars is described as a quarterly recognition of top contributors. The quarterly review is a staff practice; no code selects or expires it. The leaderboard is the reference staff use.

## Where it lives

| Concern | Location |
|---|---|
| Ladder table and admin CRUD | `convex/levels.ts`, `levels` table, `src/pages/admin/LevelsManagementPage.tsx` |
| Awarding and level-up | `convex/lib/points.ts`, `convex/notificationsInternal.ts` |
| Frontend helpers | `src/lib/utils/levels.ts` (cached ladder), `src/lib/api/levels.ts` |
| Components | `src/components/common/LevelBadge.tsx`, `LevelUpCelebration.tsx` |

`levels.list` and `levels.infoForPoints` are two of the four deliberately tokenless public functions (reference data); the level mutations are admin-only.

```tsx
<LevelBadge level={2} />
<LevelBadge level={2} points={150} showProgress size="lg" />
```
