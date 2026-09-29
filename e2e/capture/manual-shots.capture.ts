import { test, type Page, type BrowserContext } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { anyApi } from 'convex/server';
import { manifest, storageStateFor } from '../support/fixtures';
import { client, type Role } from '../support/orbit';

/**
 * Screenshots for the staff manual (docs/manual/).
 *
 * This replaces `e2e/zz-manual-shots.spec.ts`, which took the original 18 shots
 * and was never committed — so re-shooting meant writing a capture harness from
 * scratch every time the UI moved. It is deliberately a sibling of
 * screens.capture.ts rather than a mode of it, because a manual and a QA
 * gallery want opposite things from a screenshot:
 *
 *   screens.capture.ts  full-page, every route x role x viewport, for spotting
 *                       regressions. Legibility does not matter; coverage does.
 *   this file           a curated list, framed to be READ on paper.
 *
 * WHY VIEWPORT AND NOT `fullPage`. This is the fix for the clipped figures in
 * the previous PDF. A full-page capture of an admin list is a few thousand
 * pixels tall. Placed in an A4 column ~180mm wide it renders ~450mm tall —
 * taller than the 297mm page — and the manual's print CSS marks figures
 * `break-inside: avoid`. A box that cannot fit on any page and may not be split
 * is an impossible constraint, so Chrome clips it and strands the rest of the
 * page as whitespace. That is exactly what happened to the application form on
 * page 4. A viewport shot is ~112mm tall in the same column, fits, and stays
 * legible. Where the whole of something genuinely matters, `mode: 'full'` is
 * available and build.py caps the printed height so it scales rather than crops.
 *
 * Shots are written straight into docs/manual/img/. Run the optimise step after
 * (see docs/manual/README.md) — build.py embeds from img/opt/, not img/.
 *
 * DEV ONLY, and not incidentally: e2e/support/orbit.ts refuses any deployment
 * but your-dev-deployment. Production holds real applicant names, emails and matric
 * numbers, and this document gets emailed around.
 */

const OUT_DIR = path.join(process.cwd(), 'docs', 'manual', 'img');

/**
 * PERSONAL-DATA TRIPWIRE. The manual is published with the open-source
 * repository, and dev's staff accounts and some applicants are real people.
 * Any email address visible in a figure (page text OR an input's value) must
 * be a known fixture shape, or the shot fails rather than landing in a public
 * figure:
 *   - @example.com / @orbit.test          (demo and seed accounts)
 *   - @iih.ng with a digit in the local part (test-suite fixtures always carry
 *     a timestamp or random suffix: e2e-…-1785…, client-swap-…, bulk.test1…;
 *     a person's address, firstname.lastname@, does not)
 *   - orbit.agent@iih.ng                   (the platform's own agent)
 * Anything else — a real-looking address on ANY domain — is a leak.
 */
const ANY_ADDRESS = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const FIXTURE_ADDRESS =
  /^(?:[^@]+@(?:example\.com|orbit\.test)|orbit\.agent@iih\.ng|[^@\d]*\d[^@]*@iih\.ng)$/i;

/**
 * Names of real staff known to be on dev. Emails are caught above; this catches
 * a name shown on its own (a letter signatory, an author line).
 *
 * Read from a GIT-IGNORED file, one name per line — listing real people in a
 * file that ships in the public repository would publish exactly what this
 * check exists to keep out. Without the file the name check is skipped, loudly.
 */
const NAMES_FILE = path.join(process.cwd(), 'e2e', 'capture', 'real-names.local.txt');
const REAL_STAFF_NAME: RegExp | null = (() => {
  if (!existsSync(NAMES_FILE)) return null;
  const names = readFileSync(NAMES_FILE, 'utf8').split('\n').map((n) => n.trim()).filter((n) => n && !n.startsWith('#'));
  if (!names.length) return null;
  const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(names.map((n) => `\\b${esc(n)}\\b`).join('|'), 'i');
})();

/** Every address in `text` that is not a known fixture shape. */
function realLookingAddresses(text: string): string[] {
  return (text.match(ANY_ADDRESS) ?? []).filter((a) => !FIXTURE_ADDRESS.test(a));
}

/** Wide enough that admin tables are not in their stacked mobile layout. */
const VIEWPORT = { width: 1440, height: 900 };

const FREEZE_CSS = `
  *, *::before, *::after {
    animation-play-state: paused !important;
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
`;

// Same reasoning as screens.capture.ts: pin Date.now() only. Installing fake
// timers stalls the Convex client's reconnect backoff and nothing ever settles.
const FIXED_TIME = new Date('2026-01-15T09:00:00Z');

type Mode = 'viewport' | 'full' | 'element';

interface Shot {
  /** Filename in docs/manual/img/. Must match the ('shot', ...) name in content.py. */
  file: string;
  role: Role | 'signed-out';
  path: string | (() => string);
  /** Clicks needed to reach a tab that has no URL of its own. */
  prepare?: (page: Page) => Promise<void>;
  /** Hide rows / letters showing a real staff-looking address (DOM only). */
  hideRealRows?: boolean;
  /** Rewrite staff-looking addresses to a sample one (DOM text only). */
  maskAddresses?: boolean;
  /** Something that proves the tab actually mounted before the shutter fires. */
  ready?: (page: Page) => Promise<void>;
  mode?: Mode;
  /** For mode: 'element' — the region to frame. */
  selector?: string;
}

async function clickTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('button', { name, exact: true }).first();
  // The admin tab strip is overflow-x-auto; scroll it into view before clicking.
  await tab.scrollIntoViewIfNeeded().catch(() => {});
  await tab.click({ timeout: 10_000 });
  await settle(page);
}

async function clickButton(page: Page, name: string | RegExp): Promise<void> {
  const btn = page.getByRole('button', { name }).first();
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click({ timeout: 10_000 });
  await settle(page);
}

/**
 * Wait until the screen is actually SHOWING something, not merely mounted.
 *
 * `.animate-spin` alone — which is what screens.capture.ts waits on — is not
 * enough. This codebase has two loading idioms: spinners, and the skeleton
 * placeholders in components/common/SkeletonLoader.tsx, which are `animate-pulse`
 * and contain no spinner at all. Waiting only for spinners photographed the
 * SIWES Cohorts, Departments and Interns tabs as grey placeholder bars, under
 * captions describing start dates and Edit controls that were not in the
 * picture. For a QA gallery that is a cosmetic miss; for a manual it is a figure
 * that documents nothing.
 *
 * Images too: the ORBIT wordmark rendered as a broken-image icon in the same
 * shots because the shutter fired before it decoded.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  // A beat before looking. A click that triggers a refetch has not necessarily
  // rendered its spinner by the time we check, so an immediate look sees a
  // quiet page and moves on — which is how the Approved queue was photographed
  // mid-fetch. Cheap insurance against checking too early.
  await page.waitForTimeout(400);
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('.animate-spin').length === 0 &&
        document.querySelectorAll('.animate-pulse').length === 0,
      { timeout: 15_000 },
    )
    .catch(() => {});
  await page
    .waitForFunction(() => Array.from(document.images).every((i) => i.complete), {
      timeout: 10_000,
    })
    .catch(() => {});
}

/**
 * The shot list, in the order content.py uses them.
 *
 * 08 is deliberately absent: img/08-letter-page.png exists on disk but no
 * ('shot', ...) block references it, so it has been embedded in nothing since
 * the manual was first built. Do not re-shoot it; delete it.
 */
const SHOTS: Shot[] = [
  { file: '01-sign-in.png', role: 'signed-out', path: '/' },
  {
    // The /apply page is far longer than 900px, so a viewport shot stopped
    // mid-field (that was the cut-off figure on page 4 of the old PDF) and a
    // `full` shot became a tall narrow sliver once the print height cap scaled
    // it down. Framing the form element is the shape that actually reads: the
    // whole form, at a width the page can use.
    file: '02-public-form.png',
    role: 'signed-out',
    path: '/apply',
    mode: 'element',
    // The FIRST section, not the whole form. All four sections together are
    // 2.5:1, which the print height cap scales down to a strip about 79mm wide
    // — complete, and too small to read a field label on. Applicant Details is
    // what the caption is actually about.
    selector: 'form section',
  },

  { file: '03-admin-overview.png', role: 'admin', path: '/admin' },

  {
    file: '04-admissions-queue.png',
    hideRealRows: true,
    role: 'admin',
    path: '/admin',
    prepare: (p) => clickTab(p, 'Applications'),
    ready: (p) => p.getByText('All Applications').first().waitFor(),
  },
  {
    // One row, framed. The previous version of this shot was the whole queue
    // shrunk to column width, which made the thing it was pointing at — the
    // per-row actions — too small to make out.
    file: '05-application-row.png',
    role: 'admin',
    path: '/admin',
    prepare: (p) => clickTab(p, 'Applications'),
    ready: (p) => p.getByText('All Applications').first().waitFor(),
    mode: 'element',
    // A row that actually HAS the link the caption points at. Plain
    // `table tbody tr` took whichever row sorted first — an Internship
    // applicant, who supplies no SIWES form and shows no such link.
    selector: 'table tbody tr:has-text("SIWES form/letter")',
  },
  {
    file: '06-approved-filter.png',
    hideRealRows: true,
    role: 'admin',
    path: '/admin',
    prepare: async (p) => {
      await clickTab(p, 'Applications');
      // Deliberately a button, not the neighbouring <select> — that one sorts
      // (Newest first / Name A-Z / Programme). Selecting 'Approved' on it
      // matched nothing, failed silently, and left the figure on Submitted.
      await clickButton(p, 'Approved');
    },
    // Wait for a ROW, not the heading. 'All Applications' is mounted the whole
    // time, so it proved nothing and the shutter caught the table mid-fetch
    // with a spinner where the approved applicants should have been.
    ready: (p) => p.locator('table tbody tr').first().waitFor({ timeout: 20_000 }),
  },

  {
    // The letter page ELEMENT, not the page.
    //
    // `fullPage` here captured the letter modal AND the entire applications
    // queue scrolling behind it — the modal is an overlay, so the document is
    // still the long list underneath. The print height cap then scaled all of
    // that into an unreadable sliver, under a caption reading "the letter,
    // ready to print". `.orbit-letter-page` is the A4 letter body itself.
    file: '07-acceptance-letter.png',
    role: 'admin',
    path: '/admin',
    prepare: async (p) => {
      await clickTab(p, 'Applications');
      await clickButton(p, /Acceptance letter/i);
      // The overlay scrolls independently of the page behind it. Without
      // pinning it to the top the element shot started mid-toolbar and lost the
      // letterhead and addressee — the two things the figure exists to show.
      await p.locator('.orbit-print-root').evaluate((el) => el.scrollTo(0, 0)).catch(() => {});
      /*
       * Hide the chrome that does not print, WITHOUT switching to print media.
       *
       * `emulateMedia({media:'print'})` was the obvious move and it is wrong
       * here: under print the letter page carries `print:max-w-none print:p-0`,
       * because the @page rule owns the paper size instead. The element then
       * measures the full 1440px viewport width and the figure comes out
       * landscape — not the A4 page the caption promises. Screen media keeps
       * `max-w-[210mm] min-h-[297mm]`, which is the shape we want; the only
       * problem was the sticky toolbar painting over the letter's top edge, and
       * that is exactly what these rules remove.
       */
      await p.addStyleTag({
        content: '[class*="print:hidden"], .orbit-print-root .sticky { display: none !important; }',
      });
      // The signatory is a real member of staff on the dev deployment too, and
      // the manual ships in the public repository. Shown as a sample instead —
      // in the page only; the stored setting is untouched.
      // The stored signatory loads after the letter first renders (empty name
      // and title, then filled in). Substituting before that is overwritten by
      // the re-render, so wait until the name line has arrived.
      await p.waitForFunction(() => {
        const g = document.querySelectorAll('.orbit-letter-page div.font-semibold');
        return (g[g.length - 1]?.querySelectorAll('p')[0]?.textContent ?? '').trim().length > 0;
      }, undefined, { timeout: 20_000 }).catch(() => {});
      await p.locator('.orbit-letter-page').first()
        .evaluate((page) => {
          // The signature block is the LAST bold group on the page; its first
          // line is the name. (Earlier groups are the addressee.)
          const groups = page.querySelectorAll('div.font-semibold');
          const name = groups[groups.length - 1]?.querySelector('p');
          if (name) name.textContent = 'Jane Doe (sample)';
        });
      await settle(p);
    },
    mode: 'element',
    selector: '.orbit-letter-page',
  },
  {
    file: '09-letters-batch.png',
    hideRealRows: true,
    role: 'admin',
    path: '/admin',
    prepare: async (p) => {
      await clickTab(p, 'Applications');
      // Opens the batch print view over the queue. Without this the figure was
      // simply the queue again, under a caption describing a batch run.
      await clickButton(p, 'Acceptance letters');
      await p.locator('.orbit-letter-page').first().waitFor({ timeout: 20_000 }).catch(() => {});
      await p.locator('.orbit-print-root').evaluate((el) => el.scrollTo(0, 0)).catch(() => {});
      // The toolbar's Signatory line names the configured signatory, a real
      // member of staff. Sample text instead (DOM only), title span kept.
      await p.locator('p:has(> span.text-orbit-muted)').filter({ hasText: '·' }).first()
        .evaluate((el) => {
          const t = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
          if (t) t.nodeValue = 'Jane Doe (sample)';
        }).catch(() => {});
      // And the signature block on every letter in the batch (last bold group).
      await p.waitForFunction(() => {
        const g = document.querySelectorAll('.orbit-letter-page div.font-semibold');
        return (g[g.length - 1]?.querySelectorAll('p')[0]?.textContent ?? '').trim().length > 0;
      }, undefined, { timeout: 20_000 }).catch(() => {});
      await p.evaluate(() => {
        document.querySelectorAll('.orbit-letter-page').forEach((page) => {
          const groups = page.querySelectorAll('div.font-semibold');
          const name = groups[groups.length - 1]?.querySelector('p');
          if (name) name.textContent = 'Jane Doe (sample)';
        });
      });
      await settle(p);
    },
  },

  {
    file: '10-cohorts.png',
    role: 'admin',
    path: '/admin',
    prepare: async (p) => {
      await clickTab(p, 'SIWES');
      await clickTab(p, 'Cohorts');
    },
    ready: (p) => p.getByText('SIWES Management').first().waitFor(),
  },
  {
    file: '11-departments.png',
    role: 'admin',
    path: '/admin',
    prepare: async (p) => {
      await clickTab(p, 'SIWES');
      await clickTab(p, 'Departments');
      // The LEAD column names real staff. Sample text instead, DOM only.
      await p.locator('table tbody tr').first().waitFor({ timeout: 20_000 }).catch(() => {});
      await p.evaluate(() => {
        document.querySelectorAll('table').forEach((t) => {
          const heads = Array.from(t.querySelectorAll('thead th'));
          const col = heads.findIndex((h) => /^lead$/i.test((h.textContent ?? '').trim()));
          if (col < 0) return;
          t.querySelectorAll('tbody tr').forEach((row) => {
            const cell = row.children[col] as HTMLElement | undefined;
            if (cell && (cell.textContent ?? '').trim() !== '—') cell.textContent = 'Jane Doe (sample)';
          });
        });
      });
    },
    ready: (p) => p.getByText('SIWES Management').first().waitFor(),
  },
  {
    file: '12-interns.png',
    role: 'admin',
    path: '/admin',
    prepare: async (p) => {
      await clickTab(p, 'SIWES');
      await clickTab(p, 'Interns');
    },
    ready: (p) => p.getByText('SIWES Management').first().waitFor(),
  },

  {
    file: '13-streams.png',
    role: 'admin',
    path: '/admin',
    prepare: (p) => clickTab(p, 'Streams'),
  },
  {
    file: '14-tasks.png',
    role: 'admin',
    path: '/admin',
    prepare: (p) => clickTab(p, 'Tasks'),
  },
  {
    file: '15-users.png',
    role: 'admin',
    path: '/admin',
    // Interns only: dev's staff rows are real people (see the tripwire above).
    prepare: async (p) => {
      await clickTab(p, 'Users');
      await p.locator('select').filter({ has: p.locator('option[value="moderator"]') }).first()
        .selectOption('intern');
      await settle(p);
    },
  },

  { file: '16-submission-review.png', role: 'admin', path: '/admin/submissions' },
  { file: '17-logbook-review.png', role: 'admin', path: '/review' },
  { file: '18-volunteer-logbook.png', role: 'intern', path: '/logbook' },

  // ── New, for the sections the manual did not previously cover ─────────────
  {
    // The queue the whole task programme now runs through.
    file: '19-task-proposals.png',
    role: 'admin',
    path: '/tasks/proposals',
  },
  {
    // Where staff will look first when mail is paused and nothing is arriving.
    file: '20-email-logs.png',
    maskAddresses: true,
    role: 'admin',
    path: '/admin',
    prepare: async (p) => {
      await clickTab(p, 'Settings');
      await clickTab(p, 'Email Configuration');
      await clickButton(p, 'View Email Logs');
    },
    ready: (p) => p.getByText('Email Logs').first().waitFor(),
  },
  {
    file: '21-settings.png',
    role: 'admin',
    path: '/admin',
    prepare: (p) => clickTab(p, 'Settings'),
    ready: (p) => p.getByText('Admin Settings').first().waitFor(),
  },

  // ── Intern shots. Data is staged by stageInternData() before the first one. ──
  {
    file: 'i01-home.png',
    role: 'intern',
    path: '/',
    ready: (p) => p.getByText(TASK_ACCEPT.title).first().waitFor({ timeout: 20_000 }),
    prepare: async (p) => {
      await hideFixtureRows(p, '^E2E Task Proposal');
      // Feed cards are wide; the 780px floor keeps the climb from stopping at
      // the name/text block inside them.
      await hideFixtureRows(p, '^E2E (moderator|post)', 780);
    },
  },
  {
    file: 'i02-tasks.png',
    role: 'intern',
    path: '/tasks',
    ready: (p) => p.getByText(TASK_SUBMIT.title).first().waitFor({ timeout: 20_000 }),
    prepare: async (p) => {
      await p.getByText(TASK_SUBMIT.title).first().waitFor({ timeout: 20_000 }).catch(() => {});
      await hideFixtureRows(p, '^E2E Task Proposal');
    },
  },
  {
    file: 'i03-task-accept.png',
    role: 'intern',
    path: () => `/tasks/${staged.accept}`,
    ready: (p) => p.getByRole('button', { name: 'Accept Task' }).waitFor({ timeout: 20_000 }),
  },
  {
    file: 'i04-task-submit.png',
    role: 'intern',
    path: () => `/tasks/${staged.submit}`,
    ready: (p) => p.getByText('Submit Your Work').first().waitFor({ timeout: 20_000 }),
  },
  {
    file: 'i05-task-edit.png',
    role: 'intern',
    path: () => `/tasks/${staged.edit}`,
    ready: (p) => p.getByRole('button', { name: /Edit submission/ }).waitFor({ timeout: 20_000 }),
  },
  {
    file: 'i06-task-feedback.png',
    role: 'intern',
    path: () => `/tasks/${staged.feedback}`,
    ready: (p) => p.getByText(/Assessed by ORBIT Agent/).first().waitFor({ timeout: 20_000 }),
  },
  { file: 'i07-leaderboard.png', role: 'intern', path: '/leaderboard' },
  { file: 'i08-badges.png', role: 'intern', path: '/badges' },
  {
    // History, not Today: the empty entry form says nothing about what a logbook holds.
    file: 'i09-logbook.png',
    role: 'intern',
    path: '/logbook',
    prepare: async (p) => {
      await clickTab(p, 'History');
      // Expand the entry so the figure shows what a saved log contains.
      await p.getByText('Reviewed the ORBIT onboarding flow').first().click({ timeout: 20_000 });
      await settle(p);
    },
    ready: (p) => p.getByText(/Walked through sign-up/).first().waitFor({ timeout: 20_000 }),
  },
  {
    file: 'i10-messages.png',
    role: 'intern',
    // /messages/<id> opens the COMPOSE dialog pre-addressed; the conversation is
    // reached by opening the message from the inbox.
    path: '/messages',
    prepare: async (p) => {
      await p.getByText(/I'm the ORBIT Agent/).first().click({ timeout: 20_000 });
      await settle(p);
    },
    ready: (p) => p.getByText(/I'm the ORBIT Agent/).first().waitFor({ timeout: 20_000 }),
  },
  { file: 'i11-notifications.png', role: 'intern', path: '/notifications' },
  { file: 'i12-settings.png', role: 'intern', path: '/settings' },
];

/**
 * INTERN DATA STATES.
 *
 * The scaffold intern is a fresh actor every run, so its task list, inbox and
 * notifications are empty. The intern shots each need the intern in a different
 * state on a different task, and they are staged here through the same Convex
 * client and tokens the e2e specs use (never the UI, so a slow click cannot
 * cost a rate-limit slot). Everything is dev-only: `client()` refuses any other
 * deployment.
 *
 * Tasks are real rows in the scaffold stream, created once and reused by title
 * on later runs (tasks have no delete). They carry readable titles rather than
 * "E2E Scaffold Task" because the titles are IN the figures.
 */
interface StagedTask {
  title: string;
  description: string;
  submissionType: 'text' | 'link' | 'file';
  points: number;
}

const TASK_ACCEPT: StagedTask = {
  title: 'Write a welcome note for new interns',
  description:
    'Draft a short, friendly note (120 to 200 words) that a new intern would find useful on their first day: where to find tasks, how points work, and who to ask for help.',
  submissionType: 'text',
  points: 10,
};
const TASK_SUBMIT: StagedTask = {
  title: 'Audit a live IIH web property',
  description:
    'Pick one live IIH page, review it as a first-time visitor, and list the five most important problems you find. Submit a link to your write-up (a shared document is fine).',
  submissionType: 'link',
  points: 15,
};
const TASK_EDIT: StagedTask = {
  title: 'Summarise the ORBIT points system',
  description:
    'In your own words, explain how points, levels and badges work on ORBIT, with one example of each.',
  submissionType: 'text',
  points: 10,
};
const TASK_FEEDBACK: StagedTask = {
  title: 'Map the intern onboarding journey',
  description:
    'Walk through the ORBIT onboarding as a brand-new intern and describe each step, noting where you hesitated or got stuck.',
  submissionType: 'text',
  points: 20,
};

const AGENT_FEEDBACK =
  'Clear, well-structured audit with specific evidence for each issue. To reach the top band, rank the issues by who is most affected. \u2014 Assessed by ORBIT Agent (sonnet+luna). Your supervisor can revisit this at any time.';
const AGENT_MESSAGE =
  "Hi! I'm the ORBIT Agent. Your link for 'Audit a live IIH web property' asks for a sign-in, so I couldn't read it. In Google Drive choose Share \u2192 General access \u2192 Anyone with the link, and I'll try again tomorrow \u2014 or press Edit submission on the task.";
const INTERN_REPLY = 'Thank you! I have changed the sharing setting to "Anyone with the link". Please have another look.';

/** Ids the intern shots navigate to, filled in by stageInternData(). */
const staged: { accept?: string; submit?: string; edit?: string; feedback?: string; agentId?: string } = {};

async function stageInternData(): Promise<void> {
  const { users, scaffold, adminToken } = manifest();
  const convex = client();
  const intern = users.find((u) => u.role === 'intern')!;
  const admin = adminToken;

  const existing = (await convex.query(anyApi.tasks.listForUser, { token: admin })) as {
    id: string;
    title: string;
    streamId: string;
  }[];

  const ensure = async (t: StagedTask): Promise<string> => {
    const found = existing.find((e) => e.title === t.title && e.streamId === scaffold.streamId);
    if (found) return found.id;
    const created = await convex.mutation(anyApi.tasks.create, {
      token: admin,
      streamId: scaffold.streamId,
      title: t.title,
      description: t.description,
      submissionType: t.submissionType,
      points: t.points,
      deadline: Date.now() + 30 * 86_400_000,
      notify: false,
    });
    // MCP-created tasks are proposals until a supervisor approves them.
    await convex.mutation(anyApi.tasks.approveProposal, { token: admin, taskId: created.id });
    return created.id as string;
  };

  staged.accept = await ensure(TASK_ACCEPT);
  staged.submit = await ensure(TASK_SUBMIT);
  staged.edit = await ensure(TASK_EDIT);
  staged.feedback = await ensure(TASK_FEEDBACK);

  const ok = (r: unknown, what: string) => {
    if (!r || (r as { success?: boolean }).success === false) {
      throw new Error(`${what} failed: ${JSON.stringify(r)}`);
    }
  };
  const submissionFor = async (taskId: string) => {
    const rows = (await convex.query(anyApi.tasks.listSubmissions, {
      token: admin,
      taskId,
      userId: intern.id,
    })) as { id: string }[];
    return rows[0]?.id;
  };

  // i04: accepted, nothing submitted yet.
  ok(await convex.mutation(anyApi.tasks.acceptTask, { token: intern.token, taskId: staged.submit }), 'accept submit-task');

  // i05: submitted, not yet marked.
  ok(await convex.mutation(anyApi.tasks.acceptTask, { token: intern.token, taskId: staged.edit }), 'accept edit-task');
  ok(
    await convex.mutation(anyApi.tasks.submitWork, {
      token: intern.token,
      taskId: staged.edit,
      submissionText:
        'Points are earned when a supervisor approves a submission. Every 100 points is a new level. Badges are one-off awards, for example for a first approved task.',
    }),
    'submit edit-task',
  );

  // i06: submitted, then approved with a score and the agent's feedback.
  ok(await convex.mutation(anyApi.tasks.acceptTask, { token: intern.token, taskId: staged.feedback }), 'accept feedback-task');
  ok(
    await convex.mutation(anyApi.tasks.submitWork, {
      token: intern.token,
      taskId: staged.feedback,
      submissionText:
        '1. Landing page: the sign-in and apply buttons compete. 2. Application form: no progress indicator. 3. First login: the first-steps card is easy to miss. 4. Tasks: deadlines are not sorted. 5. Settings: notification toggles are unlabeled on mobile.',
    }),
    'submit feedback-task',
  );
  const submissionId = await submissionFor(staged.feedback);
  if (!submissionId) throw new Error('feedback submission row not found');
  ok(
    await convex.mutation(anyApi.tasks.reviewSubmission, {
      token: admin,
      submissionId,
      status: 'approved',
      score: 18,
      feedback: AGENT_FEEDBACK,
    }),
    'review feedback-task',
  );

  // i10: agent writes, intern replies. The MCP actor IS the ORBIT Agent here.
  const who = (await convex.query(anyApi.mcp.whoami, { token: admin })) as { id: string };
  staged.agentId = who.id;
  await convex.mutation(anyApi.messages.send, { token: admin, recipientId: intern.id, content: AGENT_MESSAGE });
  await convex.mutation(anyApi.messages.send, { token: intern.token, recipientId: who.id, content: INTERN_REPLY });

  // i09: a logbook with something in it.
  const today = new Date().toISOString().slice(0, 10);
  await convex.mutation(anyApi.logbook.saveDailyLog, {
    token: intern.token,
    logDate: today,
    participationMode: 'virtual',
    title: 'Reviewed the ORBIT onboarding flow',
    workDone:
      'Walked through sign-up and the first-steps card as a new intern, wrote down every point where I hesitated, and drafted my onboarding journey task.',
    learned: 'Small wording changes in a form can decide whether someone finishes it.',
    toolsUsed: 'ORBIT, Google Docs',
    hoursSpent: 6,
    submit: true,
  });
}

/**
 * Remove leftover test-suite fixtures from the frame.
 *
 * The dev deployment is shared with the e2e and integration suites, whose rows
 * ("E2E Task Proposal Approved Fixture", "E2E post 1790...") sort ahead of the
 * demo content. They are real rows, so they are hidden in the DOM for the shot
 * rather than deleted (streams and tasks have no delete). Climbs from the
 * matching text to the enclosing card: the first ancestor at least 100px tall
 * that shares its parent with siblings.
 */
async function hideFixtureRows(page: Page, pattern: string, minWidth = 0): Promise<void> {
  await page.evaluate(([src, minW]) => {
    const re = new RegExp(src as string);
    const hits = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,p,span,div')).filter(
      (el) => el.children.length === 0 && re.test(el.textContent ?? ''),
    );
    for (const hit of hits) {
      let el: HTMLElement | null = hit as HTMLElement;
      while (el && el.parentElement) {
        if (el.offsetHeight >= 100 && el.offsetWidth >= (minW as number) && el.parentElement.children.length > 1) break;
        el = el.parentElement;
      }
      if (el && el !== document.body) el.style.display = 'none';
    }
  }, [pattern, minWidth] as const);
  await page.waitForTimeout(200);
}

/**
 * Hide table rows / letter pages that carry a real-looking address — in the
 * DOM only. Dev holds an application from a real staff member; deleting it
 * would change dev data, so the row is simply left out of the frame. The
 * tripwire still runs afterwards, so anything this misses fails the shot.
 */
async function hideRealAddressRows(page: Page): Promise<void> {
  await page.evaluate(([anySrc, okSrc]) => {
    const any = new RegExp(anySrc, 'gi');
    const ok = new RegExp(okSrc, 'i');
    const leaks = (el: Element) => ((el as HTMLElement).innerText ?? '').match(any)?.some((a) => !ok.test(a)) ?? false;
    for (const el of Array.from(document.querySelectorAll('tr, .orbit-letter-page'))) {
      // Only the innermost match: a wrapper containing the matching row must stay.
      if (leaks(el) && !Array.from(el.querySelectorAll('tr, .orbit-letter-page')).some(leaks)) {
        (el as HTMLElement).style.display = 'none';
      }
    }
  }, [ANY_ADDRESS.source, FIXTURE_ADDRESS.source] as const);
  await page.waitForTimeout(200);
}

/**
 * Rewrite real-looking addresses (queued email recipients) to a fictional
 * one. Text only, in the page; the stored rows are untouched.
 */
async function maskRecipientAddresses(page: Page): Promise<void> {
  await page.evaluate(([anySrc, okSrc]) => {
    const any = new RegExp(anySrc, 'gi');
    const ok = new RegExp(okSrc, 'i');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeValue) n.nodeValue = n.nodeValue.replace(any, (a) => (ok.test(a) ? a : 'jane.doe@example.com'));
    }
  }, [ANY_ADDRESS.source, FIXTURE_ADDRESS.source] as const);
}

async function shoot(context: BrowserContext, shot: Shot): Promise<boolean> {
  const page = await context.newPage();
  const file = path.join(OUT_DIR, shot.file);

  try {
    await page.clock.setFixedTime(FIXED_TIME);
    await page.goto(typeof shot.path === 'function' ? shot.path() : shot.path, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.addStyleTag({ content: FREEZE_CSS });

    if (shot.prepare) await shot.prepare(page);
    if (shot.ready) await shot.ready(page).catch(() => {});
    await settle(page);

    if (shot.hideRealRows) await hideRealAddressRows(page);
    if (shot.maskAddresses) await maskRecipientAddresses(page);

    // Any celebration overlay would otherwise sit across the figure.
    const levelUp = page.getByText(/Level Up/i).first();
    if (await levelUp.isVisible().catch(() => false)) {
      await levelUp.waitFor({ state: 'hidden', timeout: 6_000 }).catch(() => {});
    }

    await page.mouse.move(0, 0).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.addStyleTag({ content: FREEZE_CSS });

    const mode: Mode = shot.mode ?? 'viewport';

    const scope = mode === 'element' && shot.selector ? page.locator(shot.selector).first() : page.locator('body');
    // Page text plus the value of every input/textarea (innerText skips them).
    const visible = await scope
      .evaluate((el) => {
        const values = Array.from(el.querySelectorAll('input, textarea'))
          .map((i) => (i as HTMLInputElement).value)
          .join('\n');
        return `${(el as HTMLElement).innerText}\n${values}`;
      })
      .catch(() => '');
    const name = REAL_STAFF_NAME ? visible.match(REAL_STAFF_NAME) : null;
    if (name) throw new Error(`a real staff name is visible (${name[0].slice(0, 2)}…) — substitute or filter it out`);
    const leaks = realLookingAddresses(visible);
    if (leaks.length) {
      const shown = leaks[0].replace(/^[^@]{2}[^@]*/, (m) => m.slice(0, 2) + '…');
      throw new Error(`a real-looking address is visible (${shown}) — frame or filter it out`);
    }

    if (mode === 'element' && shot.selector) {
      const el = page.locator(shot.selector).first();
      await el.waitFor({ timeout: 10_000 });
      await el.screenshot({ path: file, animations: 'disabled' });
    } else if (mode === 'full') {
      // Same guard as screens.capture.ts: past ~16,000px Chrome refuses, and
      // a viewport shot is worth more than a gap.
      try {
        await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
      } catch {
        await page.screenshot({ path: file, animations: 'disabled' });
        console.log(`[manual] ${shot.file} too tall for one image — captured the viewport instead`);
      }
    } else {
      await page.screenshot({ path: file, animations: 'disabled' });
    }

    console.log(`[manual] ${shot.file}  (${shot.role}, ${mode})`);
    return true;
  } catch (error) {
    // Loud, unlike the gallery sweep. A missing gallery tile is a gap; a
    // missing manual figure is a hole in a document about to be emailed out,
    // and the caption beside it will still describe a picture that is not there.
    console.error(`[manual] FAILED ${shot.file}: ${error instanceof Error ? error.message : error}`);
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * ONE TEST PER ROLE, not one test for everything.
 *
 * The first version was a single test walking all 21 shots, and it hit the
 * project's 300s timeout partway through: Playwright then tore down the context
 * and every remaining shot failed with "target closed", which reads like 20
 * broken screens rather than the one slow step it actually was. Per-role tests
 * give each group its own budget and confine a failure to its own group.
 */
const ROLES = [...new Set(SHOTS.map((s) => s.role))];

test.describe('manual shots', () => {
  test.skip(!process.env.ORBIT_MANUAL_SHOTS, 'set ORBIT_MANUAL_SHOTS=1 to re-shoot the manual');
  if (process.env.ORBIT_MANUAL_SHOTS && !REAL_STAFF_NAME) {
    console.warn(`[manual] no ${path.relative(process.cwd(), NAMES_FILE)} — the real-name check is OFF; only email addresses are checked`);
  }

  for (const role of ROLES) {
    test(`${role}`, async ({ browser }) => {
      mkdirSync(OUT_DIR, { recursive: true });

      const context = await browser.newContext({
        viewport: VIEWPORT,
        ...(role === 'signed-out' ? {} : { storageState: storageStateFor(role as Role) }),
      });

      if (role === 'intern') await stageInternData();

      const mine = SHOTS.filter((s) => s.role === role);
      const failures: string[] = [];
      for (const shot of mine) {
        if (!(await shoot(context, shot))) failures.push(shot.file);
      }
      await context.close();

      console.log(`[manual] ${role}: ${mine.length - failures.length}/${mine.length} captured`);
      if (failures.length) console.error(`[manual] MISSING (${role}): ${failures.join(', ')}`);
    });
  }
});
