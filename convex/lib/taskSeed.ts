/**
 * The week's task proposals, one set per stream.
 *
 * Five per stream per week, created as PROPOSALS rather than published tasks, so
 * a supervisor approves, edits or declines each before anyone sees it. Members
 * pick whichever they like from the approved set and must complete at least two;
 * points accumulate, so someone who does four scores higher than someone who
 * does two. The same task may be accepted by any number of people — submissions
 * are keyed on (task, user), so each gets their own.
 *
 * Content rules these follow, carried over from docs/TASK_BANK_DRAFT.md:
 *  - buildable from publicly available material, so nothing internal is needed
 *  - doable virtually, because the cohort is virtual-first
 *  - teaches a real skill AND shows something about how IIH works
 *
 * BEFORE SEEDING, REVIEW THIS FILE: `./scripts/review-tasks.sh`.
 *
 * The first 70 proposals went in unreviewed and a review afterwards found real
 * problems — tasks that would have had students submitting test data to ORBIT's
 * own live application form, fuzzing third-party production systems, dismantling
 * powered equipment and cold-contacting business owners, plus several no
 * supervisor could grade. Every one of those was cheap to catch beforehand and
 * embarrassing to catch after. The review step is not optional.
 *
 * Points are 1-20 (lib/input.ts TASK_POINTS, and LEVELS_SYSTEM.md). The
 * programme Guidelines describe a 10/20/40 scale; 40 cannot be stored, so the
 * spread here is 10 / 15 / 20 and the conflict is recorded in the task bank.
 */

export interface SeedTask {
  title: string;
  description: string;
  submissionType: 'text' | 'link' | 'file';
  points: number;
}

/** Keyed by a substring that identifies the stream, matched case-insensitively. */
export const TASK_SEED: { match: RegExp; tasks: SeedTask[] }[] = [
  {
    match: /software/i,
    tasks: [
      { title: 'Audit a live IIH web property', description: 'Pick one of iih.ng, jobs.iih.ng or url.iih.ng. Run an accessibility and performance pass. Report the five most significant issues — each with evidence, who it affects, and a proposed fix. Order them by who is most harmed, not by which is easiest.', submissionType: 'link', points: 13 },
      { title: 'Write the README you wish you had', description: 'Take any project you have built, however small, and write its README: what it does, how to run it, and the one thing a newcomer always gets wrong. Assume the reader has never seen it.', submissionType: 'link', points: 9 },
      { title: 'Reproduce a bug from a report', description: 'Find a public issue in any open-source project that you can reproduce. Write the reproduction steps precisely enough that someone else could follow them, and say what you think is happening.', submissionType: 'text', points: 14 },
      { title: 'Explain your stack choice', description: 'Describe a technical choice you have made — a language, a framework, a database — and argue the case against it as well as for it. Name the situation where your choice would be wrong.', submissionType: 'text', points: 4 },
      { title: 'Ship something small end to end', description: 'Build and deploy something that does one useful thing and is reachable at a URL. Name the user and the problem, include a README, and list three checks that prove it works plus its main limitation. It can be tiny — it must be live.', submissionType: 'link', points: 18 },
    ],
  },
  {
    match: /product test/i,
    tasks: [
      { title: 'Test plan for a public sign-up form', description: 'Write a test plan for a public sign-up form of your own choosing that you are permitted to test — your own project, or a sandbox/demo form. State what must never break, what should happen on bad input, and what happens on a slow connection. Then execute it and report what actually happened. Do NOT submit test data to ORBIT\'s live application form or any other production system.', submissionType: 'file', points: 14 },
      { title: 'Walk the booking journey as a stranger', description: 'Open iih.ng and try to book a space as someone who has never used it. Go as far as the form WITHOUT submitting anything \u2014 do not send a real booking. Record every point where you hesitated, guessed, or had to go back: what you expected, what happened, and what it cost you in clicks or confusion. Then do the same on a phone. Report the five worst moments in order of how many people they would affect, each with a screenshot and a specific fix. A finding without a proposed fix is a complaint.', submissionType: 'file', points: 10 },
      { title: 'Report one bug properly', description: 'Find a genuine bug in software you use, or reproduce one from a public issue tracker. Write it up so a stranger could reproduce it: numbered steps, expected result, actual result, environment, and how often it happens. Read-only observation only — do not attempt to break anyone\'s live system.', submissionType: 'text', points: 11 },
      { title: 'Break something on purpose', description: 'Build a small form of your own (any tool), then try to break it: empty input, enormous input, wrong type, wrong format, script tags. Report what your form caught, what it did not, and what you changed. Testing your own build keeps this safe and legal.', submissionType: 'file', points: 12 },
      { title: 'Write test cases from a description alone', description: 'Pick any published product page and write at least 12 test cases from its description alone: cover normal use, boundaries, accessibility and failure. Include the page URL and every assumption you had to make.', submissionType: 'file', points: 10 },
      { title: 'Rank your findings by impact', description: 'Take at least three defects — your own findings, or from a public issue tracker — and produce one ordered list of what should be fixed first, arguing the ordering. Severity is not the same as priority; say where they disagree.', submissionType: 'text', points: 5 },
    ],
  },
  {
    match: /blockchain|web3/i,
    tasks: [
      { title: 'Explain a transaction to a small business owner', description: 'Take any public transaction on a public explorer. Write 400 words explaining what happened, how they could verify it themselves, and one thing that could go wrong. No jargon left undefined.', submissionType: 'text', points: 8 },
      { title: 'Verify a claim from primary sources', description: 'Find a claim being made about a blockchain project and check it against the chain itself or the project documentation. Report what you found, including if the claim held up.', submissionType: 'text', points: 8 },
      { title: 'Map a real use case for Kwara', description: 'Take a problem documented in a public Nigerian or Kwara source — cite it — and assess honestly whether a blockchain helps. A well-argued "no" scores as well as a "yes".', submissionType: 'file', points: 9 },
      { title: 'Glossary for a non-technical reader', description: 'Write plain-language definitions for ten terms someone would hit in their first week. Each under 40 words, none of them using another term on your list.', submissionType: 'text', points: 5 },
      { title: 'Read a whitepaper and summarise the risk', description: 'Pick any public whitepaper. In one page, state what it proposes and what its biggest unaddressed risk is.', submissionType: 'file', points: 9 },
    ],
  },
  {
    match: /graphic design|animation/i,
    tasks: [
      { title: 'Design to a brief: workshop announcement', description: 'Work to a real brief, in the shape IIH actually issues them. OBJECTIVE: design the announcement flyer for a 3-day Data Skills Workshop at the Ilorin Innovation Hub. It is registration-driven, so the primary message is the workshop name and the call to register. DELIVERABLES: two formats, both required \u2014 square 1080x1080px for social, and 16:9 landscape for the reception display screen. COPY, use exactly: title \u201c3-Day Data Skills Workshop\u201d; dates Monday 22 \u2013 Wednesday 24 September; time 10:00AM \u2013 2:00PM WAT daily; venue Ilorin Innovation Hub; register at bit.ly/IIHDataSkills; and the line \u201cApplications close Friday 12 September\u201d. REQUIREMENTS: a clear call-to-action element for registration; room for a QR code (a placeholder block is fine); and space reserved for partner logos along one edge \u2014 use grey placeholder blocks, do not invent or reproduce real partner marks. SUBMIT: both formats, plus three sentences on your visual hierarchy \u2014 what you made loudest, what you made quietest, and why. The test is whether someone glancing at the reception screen for two seconds leaves knowing what it is and that they must register.', submissionType: 'file', points: 14 },
      { title: 'Event flyer set in the IIH visual language', description: 'IIH publishes flyers for sessions like Legal Thursdays. Design a three-format set — feed, story, banner — for a session of your own invention, and add a short note on the choices you made.', submissionType: 'file', points: 13 },
      { title: 'Redraw something badly designed', description: 'Find a poster, sign or form that fails at its job. Redesign it, and explain in three sentences what was wrong and what you changed. Include the original alongside your version — without the before, nobody can judge the after.', submissionType: 'file', points: 10 },
      { title: 'Build a mini type and colour system', description: 'Choose two typefaces and five colours that work together, show them applied to a headline, body text and a button, and say what each is for.', submissionType: 'file', points: 9 },
      { title: 'Animate one idea in under ten seconds', description: 'Produce a short motion piece that communicates a single message. It can be simple. The test is whether the message survives without sound.', submissionType: 'link', points: 11 },
      { title: 'Critique your own work', description: 'Submit a piece you have made together with the critique you would expect from a demanding art director. Be specific about what does not work and what you would change first. The file must contain both the work and the critique.', submissionType: 'file', points: 5 },
    ],
  },
  {
    match: /social media|content creation/i,
    tasks: [
      { title: 'Plan the announcement, not just the post', description: 'Build a five-post calendar announcing a training programme. For each: platform, copy, the asset described, posting time, and what it is trying to achieve. Include what you would do if post one underperformed.', submissionType: 'file', points: 8 },
      { title: 'Rewrite one post three ways', description: 'Take a single announcement and write it for three different platforms. Explain what changed and why — length is not the only difference.', submissionType: 'text', points: 5 },
      { title: 'Shoot and cut a 30-second reel', description: 'Make a short video explaining one thing you know well. Vertical, under 30 seconds, watchable with the sound off.', submissionType: 'link', points: 13 },
      { title: 'Turn an IIH page into a carousel', description: 'Take the content of one real page on iih.ng \u2014 a facility, a programme, or a news item \u2014 and turn it into a five-slide carousel for Instagram or LinkedIn. Square, 1080x1080px. Slide one has to earn the swipe; slide five has to say what to do next. Write the caption and the alt text for each slide too. Say which page you used and link it, so the facts can be checked against the source.', submissionType: 'file', points: 10 },
      { title: 'Analyse a campaign that worked', description: 'Find a Nigerian brand campaign you rate. Break down what it did, who it was for, and which single decision made it work.', submissionType: 'file', points: 7 },
      { title: 'Write ten headlines for one story', description: 'One story, ten headlines, each a genuinely different angle. Then pick the best and say why the other nine lose.', submissionType: 'text', points: 5 },
    ],
  },
  {
    match: /writing|storytell/i,
    tasks: [
      { title: 'Profile a builder', description: 'Write a 500-word profile of someone building something in Nigeria, in the voice of the IIH newsletter, using published interviews or talks as your source. Lead with a specific detail, not an adjective. Submit the piece, your source links, and the questions you would still want to ask.', submissionType: 'text', points: 12 },
      { title: 'Rewrite a page on iih.ng', description: 'Choose one page on iih.ng \u2014 About, Facilities, Careers or Events \u2014 and rewrite its copy so a first-time reader understands what IIH does and what to do next. Keep every fact exactly as it is; you are changing the words, not the claims. Submit the original text and your version side by side, then three sentences on what you cut and why. Length is not the goal: the test is whether someone skimming for ten seconds leaves knowing more than they did.', submissionType: 'file', points: 9 },
      { title: 'Explain something hard in 300 words', description: 'Pick a concept you understand and most people do not. Explain it to an intelligent reader who knows nothing about it. No jargon without a definition.', submissionType: 'text', points: 6 },
      { title: 'Rewrite something bureaucratic', description: 'Find a piece of official writing that is hard to read — a form, a notice, a policy. Rewrite it so it says the same thing and can be understood on first reading.', submissionType: 'text', points: 9 },
      { title: 'Open five different ways', description: 'Take one story and write five different opening paragraphs. Then argue for one.', submissionType: 'text', points: 5 },
      { title: 'Write a 700-word opinion piece', description: 'Make an argument about technology, work or education in Nigeria that you actually believe. State the strongest objection to your own case and answer it.', submissionType: 'file', points: 7 },
    ],
  },
  {
    match: /research|documentation/i,
    tasks: [
      { title: 'Brief someone who has ten minutes', description: 'Two pages on digital-tool adoption among small businesses in Kwara: what is known, what is contested, what is missing. Every claim cited. End with the three questions the evidence cannot answer.', submissionType: 'file', points: 13 },
      { title: 'Build a survey that would actually work', description: 'Design a ten-question survey to find out something specific. For each question, say what you would do with the answer. Cut any question that fails that test.', submissionType: 'file', points: 7 },
      { title: 'Fact-check three claims', description: 'Take three claims circulating about technology in Nigeria and check each against a primary source. Report what you found, including where you could not settle it.', submissionType: 'text', points: 9 },
      { title: 'Document a process from observation', description: 'Watch or perform any repeatable process and document it so someone else could follow it exactly. Note where you had to guess.', submissionType: 'file', points: 8 },
      { title: 'Summarise a long report honestly', description: 'Find a published report of 20+ pages. Summarise it in one page without losing its caveats — the caveats are the hard part.', submissionType: 'file', points: 8 },
    ],
  },
  {
    match: /entrepreneur|innovation support/i,
    tasks: [
      { title: 'Build the selection rubric, and defend it', description: 'A founder programme has 200 applicants and 30 places. Produce the scoring rubric with weights, the evidence you would ask for, how you would keep two reviewers within a point of each other, and what you do with the 170 you turn down.', submissionType: 'file', points: 9 },
      { title: 'Close the loop with a funder', description: 'A founder programme took 30 of 200 applicants and has just finished. Design the one-page report you would send its funder: what you would measure, how you would collect it without burdening participants, and the single number you would lead with. State one thing your measurements could not tell you.', submissionType: 'file', points: 9 },
      { title: 'Applicant readiness checklist', description: 'Using the published criteria of a real grant or training programme — cite it — build a checklist an applicant could work through, and identify five eligibility or evidence failures that follow directly from those published criteria.', submissionType: 'file', points: 9 },
      { title: 'Analyse how a small business tracks its money', description: 'Using a published Nigerian SME case study or a public interview, analyse how that business tracks money, customers or stock. Cite your source. Explain what surprised you and what one tool would change most.', submissionType: 'text', points: 7 },
      { title: 'Plan how you would test a programme idea', description: 'Plan customer discovery for a proposed programme: your hypotheses, who you would speak to and why, the interview guide, and the table you would record evidence in. No interviews required — the plan is the deliverable.', submissionType: 'file', points: 7 },
    ],
  },
  {
    match: /admin|task support/i,
    tasks: [
      { title: 'Map a real workflow, then improve it', description: 'A booking request arrives by web form and must end with a confirmed room and a signed agreement. Map that flow as a diagram, mark every point where it could stall, draft the two emails you would send, and name the one step you would remove.', submissionType: 'file', points: 8 },
      { title: 'Build a checklist someone else can run', description: 'Here is a flawed checklist: (1) send email (2) get approval (3) book room (4) tell everyone. Repair it — identify what is missing, reorder where needed, add the exceptions, and submit the finished version.', submissionType: 'file', points: 5 },
      { title: 'Design a simple tracker', description: 'Build a tracker with at least 20 sample rows, input validation, at least two formulas, a summary section, and a short usage note. It must be usable by someone who did not build it.', submissionType: 'file', points: 13 },
      { title: 'Write the three emails a request process needs', description: 'For a facility booking request, write three emails: the acknowledgement, the approval, and the refusal. State the decision rules you assumed. The refusal is the one that matters.', submissionType: 'text', points: 6 },
      { title: 'Report a week in one page', description: 'From this week\'s own ORBIT activity — tasks you saw, work you did, anything you observed — write a one-page report a busy person could read in two minutes: totals, exceptions, decisions needed, next actions.', submissionType: 'file', points: 4 },
    ],
  },
  {
    match: /event|community/i,
    tasks: [
      { title: 'Write the concept note for a programme event', description: 'IIH runs sessions, clinics, bootcamps and demo days, and each one starts as a concept note somebody has to be able to say yes or no to. Choose an event IIH could plausibly run in Ilorin and write its note: the title and one-line summary, the problem it addresses and the evidence for it, who it is for and roughly how many, the format and length, what a participant leaves with, what it needs to run (venue, facilitators, materials, a costed estimate in naira with dated sources), how you would measure whether it worked, and the strongest argument for not running it. Two pages at most — the point is that a busy reader can decide from it.', submissionType: 'file', points: 12 },
      { title: 'Run of show for a session with protocol', description: 'Plan a two-hour hybrid session shaped like IIH Legal Thursdays. Submit a run of show to the minute, a risk register with mitigations, and the roles needed. Handle protocol order when dignitaries attend, and what you do when a speaker is twenty minutes late.', submissionType: 'file', points: 9 },
      { title: 'Budget an event honestly', description: 'Cost a 100-person event in Ilorin, line by line, in naira, against a ceiling of ₦1,500,000. Use dated public prices and cite them. Include contingency and the things people forget. State which line you would cut first under pressure.', submissionType: 'file', points: 10 },
      { title: 'Design the registration experience', description: 'From invitation to badge, describe what an attendee experiences. Mark every point where they could get confused or stuck.', submissionType: 'file', points: 7 },
      { title: 'Plan community engagement for a month', description: 'A community of 300 members currently sees 20 active per week. Propose four weeks of activity to raise that, with an owner, a weekly target and a measurement method for each.', submissionType: 'file', points: 7 },
      { title: 'Write the post-event report', description: 'An event ran for 100 invited guests; 68 attended and 41 returned feedback averaging 4.1/5. Write the one-page report a sponsor would want: what happened, who came, what it achieved, and what you would do differently.', submissionType: 'text', points: 5 },
    ],
  },
  {
    match: /e-?learning/i,
    tasks: [
      { title: 'Turn a talk into a module', description: 'Design a 20-minute self-paced micro-module on any topic you know well: learning objectives, segment breakdown, one activity, and an assessment that actually tests the objective.', submissionType: 'file', points: 9 },
      { title: 'Write learning objectives that can be tested', description: 'Take any subject and write five objectives. Each must be something you could observe someone doing — not "understand" or "be aware of".', submissionType: 'text', points: 5 },
      { title: 'Build a five-question assessment', description: 'Write five questions that distinguish someone who understands from someone who has memorised. Include the answer key and why each wrong option is tempting.', submissionType: 'file', points: 8 },
      { title: 'Storyboard a short lesson', description: 'Storyboard a lesson of under five minutes: what is on screen, what is said, and what the learner does.', submissionType: 'file', points: 7 },
      { title: 'Critique a course you have taken', description: 'Review any course you have done. What worked, what did not, and what one change would improve it most.', submissionType: 'text', points: 4 },
    ],
  },
  {
    match: /telecom/i,
    tasks: [
      { title: 'Design connectivity that survives a bad day', description: 'Design the network for a co-working floor of 60 concurrent users in Ilorin: topology, capacity assumptions, redundancy and failover, backup power, data caps, and monthly cost in naira using dated public ISP pricing. State what breaks first under load and what you would monitor to see it coming.', submissionType: 'file', points: 14 },
      { title: 'Explain how a call reaches a tower', description: 'Trace, in plain language, what happens between pressing dial and the other phone ringing. Use only public sources.', submissionType: 'text', points: 7 },
      { title: 'Desktop coverage plan', description: 'Desktop coverage plan: sketch the floor plan of a building you already know, and plan wireless coverage for it using published equipment specifications. No site visit and no measurement — state every assumption. Include cost in naira and the compromises you accepted.', submissionType: 'file', points: 11 },
      { title: 'Read the industry from public sources', description: 'Using only published material on how tower operators work, explain why infrastructure is the layer everything above it depends on.', submissionType: 'file', points: 7 },
      { title: 'Troubleshoot a slow connection', description: 'A small office of twelve people on a shared router reports that video calls freeze every afternoon, while email and browsing stay fine. Write the diagnostic sequence you would follow, in order, and state what each step rules out. Say where you would stop and escalate to the provider, and what evidence you would hand them.', submissionType: 'text', points: 6 },
    ],
  },
  {
    match: /mechanical|automobile/i,
    tasks: [
      { title: 'Keep a makerspace running', description: 'For a small makerspace — 3D printer, laser cutter, hand tools — produce a preventive maintenance schedule, a consumables list with reorder points, and a one-page safety induction. Cite manufacturer guidance where you rely on it.', submissionType: 'file', points: 12 },
      { title: 'Diagnose from symptoms', description: 'A generator starts, runs for two minutes, then cuts out; it restarts and repeats. Write the diagnostic sequence you would follow as a decision tree, what each step eliminates, and where you would stop for safety.', submissionType: 'text', points: 8 },
      { title: 'Explain a mechanism from public diagrams', description: 'Explain a mechanism from public diagrams and manuals: how it works, what wears out, and how you would know before it failed. Include a labelled diagram. Do NOT dismantle anything powered, pressurised, or fitted to a vehicle.', submissionType: 'file', points: 9 },
      { title: 'Write a safety induction someone will read', description: 'One page a first-time user must read before touching equipment. Short enough that they will.', submissionType: 'file', points: 6 },
      { title: 'Cost a repair honestly', description: 'Price a common vehicle or generator repair using dated Nigerian online prices: parts, labour, time, and the argument for repairing rather than replacing. Cite your price sources. No workshop access needed.', submissionType: 'file', points: 10 },
    ],
  },
  {
    match: /special|emerging/i,
    tasks: [
      { title: 'Write a concept note that could be said no to', description: 'One page proposing an emerging-technology pilot IIH could run in Ilorin: the problem, who it serves, what you would build, the effort, how you would know it worked, and the strongest argument against doing it.', submissionType: 'file', points: 8 },
      { title: 'Scan for what is coming', description: 'Identify three technologies you think will matter in Kwara within two years. For each, say what would have to be true first.', submissionType: 'file', points: 6 },
      { title: 'Prototype anything in a week', description: 'Build the roughest working version of an idea: name the user and the problem, get one interaction working end to end, and submit a URL, a README, its limitations, and three checks that prove it does what you claim.', submissionType: 'link', points: 20 },
      { title: 'Kill your own idea', description: 'Take a proposal you like and write the case against it as convincingly as you can.', submissionType: 'text', points: 4 },
      { title: 'Find the second-order effect', description: 'Pick a technology being adopted in Nigeria — cite a dated source for the adoption — and describe a second-order consequence its advocates are not discussing: the causal chain, who is affected, the strongest counterargument, and what you are unsure of.', submissionType: 'text', points: 8 },
    ],
  },
];

/** The five tasks for a stream, or an empty list if nothing matches its name. */
export function seedTasksFor(streamName: string): SeedTask[] {
  const hit = TASK_SEED.find((s) => s.match.test(streamName));
  return hit ? hit.tasks : [];
}
