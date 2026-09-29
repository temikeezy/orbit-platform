/**
 * What each stream is, in its own words, and how it greets a new member.
 *
 * The descriptions the streams shipped with were fragments lifted from the
 * programme spreadsheet — "Coding, app development (strict entry)",
 * "Research, product support". They work as a row in a table and not at all as
 * the first thing someone reads on the stream's own page, where the question is
 * "is this me, and what will I actually be doing".
 *
 * Written from each stream's real task bank rather than invented, so what the
 * page promises is what the queue delivers. Matched on name like
 * lib/taskSeed.ts and lib/streamIcon.tsx, so a stream created later picks up
 * sensible copy without a code change and an unmatched one falls back rather
 * than breaking the page.
 */

import { ORG_SHORT_NAME } from '../config/org';

export interface StreamCopy {
  /** One or two sentences: what this stream is for. */
  description: string;
  /** How the ORBIT Agent greets someone who has just joined. */
  welcome: string;
}

const RULES: { match: RegExp; copy: StreamCopy }[] = [
  {
    match: /software|coding|app develop/i,
    copy: {
      description:
        'Building and shipping software — web apps, tools, and the small things that make them usable. Work here tends to end in something that runs, with a README and a way for someone else to check it.',
      welcome:
        'Welcome. Most of what you do here ends in working code someone else can run, so keep your READMEs honest and your commits small. If a task asks for a live URL, that is the whole point of it — a thing that works on your machine is not yet a thing that works.',
    },
  },
  {
    match: /product test|testing|\bqa\b/i,
    copy: {
      description:
        'Finding what breaks before a user does. Test plans, reproductions, and bug reports written clearly enough that someone else can follow them without asking you a question.',
      welcome:
        'Welcome. The skill here is not finding bugs — it is writing them up so a stranger can reproduce one on the first try. Numbered steps, what you expected, what happened. Never test against a live production system unless a task explicitly says you may.',
    },
  },
  {
    match: /blockchain|web3|crypto/i,
    copy: {
      description:
        'Making sense of blockchain claims and where they genuinely help. Mostly research, explanation and verification against primary sources rather than building on-chain.',
      welcome:
        'Welcome. This stream rewards scepticism: most of the work is checking whether a claim survives contact with its own documentation. Cite what you check, and be willing to conclude that something does not need a blockchain.',
    },
  },
  {
    match: /graphic|design|animation/i,
    copy: {
      description:
        'Visual work for real briefs — flyers, social assets, type and colour systems, short motion pieces. Output is judged on whether it communicates, not on how much is on the page.',
      welcome:
        'Welcome. Work to the brief you are given: the formats and copy in it are the requirements, not suggestions. When you submit, say what you made loudest and why — the reasoning is half of what a reviewer is looking at.',
    },
  },
  {
    match: /social media|content creation/i,
    copy: {
      description:
        `Planning and making what ${ORG_SHORT_NAME} says in public — posts, carousels, short video, and the thinking behind a campaign rather than a single asset.`,
      welcome:
        'Welcome. A post is the visible end of a plan; most tasks here ask for both. Write the caption and the alt text as carefully as you make the image, and say which real page or event your facts came from.',
    },
  },
  {
    match: /writing|storytell|blog/i,
    copy: {
      description:
        'Writing that has to be read by someone who did not have to read it — profiles, explainers, rewrites and argued pieces. Clarity over length.',
      welcome:
        'Welcome. Almost every task here can be answered in fewer words than you first think. Where you are rewriting something real, keep every fact exactly as it is — you are changing the words, not the claims.',
    },
  },
  {
    match: /research|documentation/i,
    copy: {
      description:
        'Turning scattered sources into something someone can act on — briefs, fact-checks, surveys and process documentation, with the evidence attached.',
      welcome:
        'Welcome. The rule that matters here is that every claim is traceable. A brief nobody can check is an opinion with formatting, so cite as you write rather than at the end.',
    },
  },
  {
    match: /entrepreneur|innovation support|business/i,
    copy: {
      description:
        'The work behind running programmes — selection criteria, applicant readiness, funder reporting and testing whether an idea is worth building.',
      welcome:
        'Welcome. This is the unglamorous half of programme work and the half that decides whether it succeeds. Where a task asks you to defend a design, the defence is the deliverable — say what you would give up and why.',
    },
  },
  {
    match: /admin|task support|organis|organiz/i,
    copy: {
      description:
        'Making processes run without the person who designed them — workflows, checklists, trackers and the short written pieces that keep a team aligned.',
      welcome:
        'Welcome. The test for everything here is whether someone who was not in the room can pick it up and use it. If a tracker needs you to explain it, it is not finished.',
    },
  },
  {
    match: /event|community/i,
    copy: {
      description:
        'Getting events from an idea to a room full of people — concept notes, run of show, budgets, registration and the report afterwards.',
      welcome:
        'Welcome. Events fail on the details nobody wrote down, which is why the tasks here ask for minute-level plans and costed budgets with real prices. Start with the concept note: everything else follows from it.',
    },
  },
  {
    match: /e-?learning|course|training/i,
    copy: {
      description:
        'Designing how people learn something — objectives, modules, assessments and storyboards that hold together from start to finish.',
      welcome:
        'Welcome. The craft here is alignment: if your objective, your content and your assessment do not test the same thing, the module does not work however good it looks. Write objectives you can actually test.',
    },
  },
  {
    match: /telecom/i,
    copy: {
      description:
        'Network and connectivity work — capacity and coverage planning, costed designs, and explaining how any of it works to people who need to decide something.',
      welcome:
        'Welcome. Assume the reader is paying for what you propose: state your assumptions, price them with dated sources, and say what happens on a bad day rather than only on a good one.',
    },
  },
  {
    match: /mechanical|automobile|automotive/i,
    copy: {
      description:
        'Keeping physical things working and understood — diagnostics, maintenance planning, safety documentation and honest repair costing.',
      welcome:
        'Welcome. Most tasks here are documentation of physical judgment: the decision tree, the safety stop, the price with its source. Be specific about what you would rule out and how.',
    },
  },
  {
    match: /special|emerging/i,
    copy: {
      description:
        'Work that does not fit the other streams yet — concept notes, horizon scanning, and prototypes built to find out whether something is worth pursuing.',
      welcome:
        'Welcome. This stream exists for things nobody has decided about, so the useful skill is arguing both sides. If a task asks you to kill your own idea, do it properly — that is the deliverable.',
    },
  },
];

const FALLBACK: StreamCopy = {
  description:
    'A working group inside ORBIT. Tasks appear here each week for members to take on, submit, and have reviewed by their supervisor.',
  welcome:
    'Welcome to the stream. Tasks appear here weekly — take on the ones that interest you, submit your work, and your supervisor will review it. Two a week is the minimum; more is up to you.',
};

export function streamCopyFor(name: string | null | undefined): StreamCopy {
  const value = (name ?? '').trim();
  for (const rule of RULES) if (rule.match.test(value)) return rule.copy;
  return FALLBACK;
}
