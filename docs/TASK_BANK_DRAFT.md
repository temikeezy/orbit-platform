# ORBIT Task Bank — draft candidates

**Status:** draft for review. Not for publishing.
**Purpose:** one candidate task per stream that teaches a real skill *and* shows
participants how IIH actually works — learnable virtually, and buildable from
public information only.

These are written to be judged, not shipped. If the delivery quality is good,
individual tasks here can be promoted into the real programme.

---

## What I read, and where I drew the line

You said the folder is hidden from ORBIT users, not from me, so I went through it
properly. It holds **3,881 files**. I classified rather than opened everything:

| Category | Files | Verdict |
|---|---|---|
| PII — applicant and attendee data | 71 | **Never.** Names, emails, dates of birth, passport-photo links |
| Money — budgets, invoices, audits, bank, payroll, grading | 284 | **Never** in participant-facing material |
| Legal — MoUs, LOIs, contracts, board resolutions | 85 | **Never** |
| Client / commercial — proposals, pitches, client plans | 307 | Useful to me for *shape*; contents never leave the building |
| Brand & templates | 115 | Usable |
| Programme & curriculum | 129 | Usable |
| Media / assets | 1,318 | Usable |
| Unclassified | 1,572 | Not opened — no reason to |

**What I actually opened:** the ORBIT Guidelines, the per-stream onboarding files
(headers only — see below), and `AI Bootcamp Sample.docx`. Nothing else.

Two things worth reporting precisely:

**The per-stream onboarding CSVs are personal data.** `ORBIT_Onboarding_By_Stream_Split/`
looked like a task library from its filenames. It is not — it is form responses
carrying names, emails, dates of birth, gender and passport-photo links. I read
only the *stream option strings* out of the questionnaire column and nothing else.
Those strings turned out to be the single most useful thing in the folder, because
they are the stream definitions **as applicants themselves saw them on the form**.

**`AI Bootcamp Sample.docx` is a client proposal**, not a curriculum. It is a
sample agenda pitched to a named client, listing their internal use cases and the
other firms IIH would deliver alongside. I took one thing from it: the *shape* IIH
teaches in — awareness and foundations, then hands-on labs, then a capstone
presented to a panel. That shape is a pedagogical pattern, not confidential
information, and the tasks below are built to end in something presentable for the
same reason. No detail from that document appears anywhere in this file.

## The stream definitions applicants were actually given

Authoritative, because this is the wording on the application form:

| Stream | As shown to applicants |
|---|---|
| Admin & Task Support | Organization, reporting, checklists |
| Blockchain & Web3 | Research, product support |
| E-Learning | Course design, digital content |
| Event Coordination & Community Engagement | Event planning, logistics, community management |
| Graphic Design & Animation | Posters, explainer graphics, motion design |
| Mechanical/Automobile Engineering | *(strict entry)* |
| Product Testing | Feedback on new tools and products |
| Research & Documentation | Data collection, reports, surveys |
| Social Media & Content Creation | Videos, reels, campaigns |
| Software Engineering | *(strict entry)* — coding, app development |
| Special/Emerging Projects | New opportunities as approved |
| **Telecoms Engineering** | **with IHS Towers** *(strict entry)* |
| Writing & Storytelling | Blogs, articles, reviews, thought pieces |

Two consequences:

- **The IHS Towers partnership on Telecoms is already disclosed to participants** —
  it is printed on the form they filled in. I had previously kept IHS out of the
  task bank on the assumption it was confidential. The *partnership* is not; the
  *client proposal* still is, and those remain separate things.
- **Entrepreneurship & Innovation Support does not appear on this form** but is a
  live stream in ORBIT with 14 first-choice applicants. It was added after this
  intake. Its scope is now decided: **this stream works on IIH programmes-team
  activity** — the running of programmes themselves. Suggested line in the form's
  voice: *"Entrepreneurship & Innovation Support – Programme design, applicant
  support, founder research."*

## ⚠️ Finding: the points cap contradicts the Guidelines

`IIH ORBIT Guidelines.docx` weights tasks like this:

| Activity | Points |
|---|---|
| Task submission (basic) | 10 |
| Task submission (standard) | 20 |
| **Task submission (complex)** | **40** |
| Partial submission | 5–15 |
| Event support (logistics/ushering) | 15 |
| **Event coordination role** | **30** |
| Peer mentoring / training | 20 |
| **Content featured on IIH platforms** | **25** |
| **Outstanding contribution** | **50** |

The server bound shipped today is **1–20**, taken from `LEVELS_SYSTEM.md`
("max 20 points per task"). Under it, every row marked in bold is **rejected**.

Two documents disagree and the code currently enforces the stricter one. This
needs a decision before real tasks are created:

1. **Raise the cap to 50** to match the Guidelines. The level thresholds in
   `LEVELS_SYSTEM.md` were built assuming 20, so they would want re-checking.
2. **Keep 20** and re-weight the Guidelines table.

Most of the tasks below are "complex" in the Guidelines' sense — research briefs,
design systems, test plans — so under the current cap they would all have to be
worth 20 or less. Flagging rather than choosing; it changes the economy.

---

## The tasks

Each is virtual-first, needs no IIH access, and is submittable as `text`, `link`
or `file`.

### Software Engineering
**Audit a live IIH product and file what you find.**
Pick one of IIH's public web properties (`iih.ng`, `jobs.iih.ng`, `url.iih.ng`).
Run an accessibility and performance pass. Submit the top five issues, each with
evidence, the affected user, and a proposed fix — ordered by who is most harmed,
not by how easy it is.
*Teaches:* auditing real software rather than toy problems; writing a defect
someone can act on. *Shows:* IIH builds and operates its own products.
`link` · complex

### Product Testing
**Write the test plan for the form you filled in.**
The ORBIT application form at `orbit2.iih.ng/apply` is public. Produce a test
plan for it: what must never break, what should happen on bad input, what happens
on a slow connection. Then execute it and report what actually happened.
*Teaches:* the difference between a test plan and clicking around; reporting a
bug so it can be reproduced. *Shows:* how admissions intake works end to end.
`file` · complex

### Blockchain & Web3
**Explain a transaction to someone who does not care about crypto.**
Take any public transaction on a public explorer. Write a 400-word explanation
for a Kwara MSME owner of what happened, how they could verify it themselves, and
one thing that could go wrong. No jargon left undefined.
*Teaches:* verification from primary sources, and translation — the harder half.
*Shows:* IIH's audience is small business owners, not crypto natives.
`text` · standard

### Graphic Design & Animation
**Design an event flyer set in the IIH visual language.**
IIH publishes flyers for sessions like Legal Thursdays and InnovateAI. Using the
published IIH brand as reference, design a three-format set (feed, story,
banner) for a session of your own invention. Include a short note on the choices
you made and why.
*Teaches:* designing inside a brand rather than around it; format discipline.
*Shows:* the cadence of IIH's event marketing.
`file` · complex

### Social Media & Content Creation
**Plan the announcement, not just the post.**
Build a five-post content calendar announcing a training programme. For each:
the platform, the copy, the asset described, the posting time, and what it is
trying to achieve. Include what you would do if post one underperformed.
*Teaches:* campaigns as sequences with a goal, not one-off posts.
*Shows:* how IIH announces programmes and fills seats.
`file` · standard

### Writing & Storytelling
**Profile a builder.**
Interview a peer in another stream — 20 minutes is enough — and write a 500-word
profile in the voice of the IIH newsletter's founder stories. Lead with a
specific detail, not an adjective. Submit the piece and your question list.
*Teaches:* interviewing, and that a story is chosen rather than transcribed.
*Shows:* IIH's storytelling function and why it exists.
`text` · standard

### Research & Documentation
**Brief someone who has ten minutes.**
Produce a two-page brief on digital-tool adoption among small businesses in
Kwara: what is known, what is contested, what is missing. Every claim cited.
End with the three questions the evidence cannot answer.
*Teaches:* citation discipline, and stating the limits of your own evidence.
*Shows:* the MSME audience behind IIH's entrepreneurship programming.
`file` · complex

### Entrepreneurship & Innovation Support
> This stream works on **IIH programmes-team activity** — the running of
> programmes, not just the studying of them. Tasks should sit inside the
> programme lifecycle: designing it, filling it, selecting for it, supporting the
> cohort through it, and reporting on what it achieved.

**Build the selection rubric, and defend it.**
IIH publicly runs founder and MSME programmes — Legal Thursdays clinics, the DBN
entrepreneurship training, masterclasses. Take a programme of that shape with 200
applicants and 30 places. Produce: the scoring rubric with weights, the evidence
you would ask each applicant for, how you would keep two reviewers scoring the
same application within a point of each other, and what you do with the 170 you
turn down.
*Teaches:* that selection is a designed instrument, not an opinion — and that
rejection is part of programme design, not an afterthought.
*Shows:* what the programmes team actually does between announcing an opportunity
and running it.
`file` · complex

**Second candidate — closing the loop.**
Design the one-page report you would send a funder after that programme ran: what
you would measure, how you would collect it without burdening participants, and
which single number you would lead with. State one thing your measurements could
not tell you.
*Teaches:* outcome measurement and honest reporting.
*Shows:* programmes are accountable to someone after they end.
`file` · complex

### Admin & Task Support
**Map a real workflow, then improve it.**
IIH takes facility bookings through a public website form which produces a
booking request and a Facility Use Agreement. Map that flow as a process
diagram, mark where a request could stall, and draft the two email templates you
would send. Then name the one step you would remove.
*Teaches:* process mapping and writing operational copy.
*Shows:* a real IIH operational flow, start to finish.
`file` · standard

### Event Coordination & Community Engagement
**Run of show for a session with protocol.**
Plan a two-hour hybrid session in the shape of IIH Legal Thursdays: a talk, then
one-to-one clinics. Submit a run of show **to the minute**, a risk register with
mitigations, and the roles you would need. Two things it must handle: the correct
protocol order when dignitaries attend — anthem, opening, addresses in order of
seniority, entertainment, vote of thanks, closing — and what you actually do when
a speaker is twenty minutes late.
*Teaches:* that a run of show is a timed document, not an agenda; and protocol
order, which is a real constraint at Nigerian institutional events and is
routinely got wrong. *Shows:* the shape IIH's own flagship events run to.
`file` · complex

> Modelled on the structure of a real IIH event flow, not its content. No
> attendee, speaker or dignitary from any actual event is named here, and none
> should be in the task as published — the transferable thing is the ordering
> convention, which is public knowledge.

### E-Learning
**Turn a talk into a module.**
IIH has publicly run an AI Agents Masterclass. Design a 20-minute self-paced
micro-module on any topic you know well: learning objectives, the segment
breakdown, one activity, and an assessment that actually tests the objective.
*Teaches:* instructional design — objectives first, content second.
*Shows:* how IIH's training function turns expertise into something repeatable.
`file` · complex

### Special / Emerging Projects
**Write a concept note that could be said no to.**
One page proposing an emerging-technology pilot IIH could run in Ilorin: the
problem, who it serves, what you would build, what it would cost in effort, how
you would know it worked, and the strongest argument against doing it.
*Teaches:* concept notes, and that a proposal with no stated risk is not a
proposal. *Shows:* how initiatives get evaluated before they start.
`file` · complex

### Mechanical / Automobile Engineering
**Keep a makerspace running.**
For a small makerspace set — 3D printer, laser cutter, basic hand tools — produce
a preventive maintenance schedule, a consumables list with reorder points, and a
one-page safety induction a first-time user must read. Cite manufacturer
guidance where you rely on it.
*Teaches:* maintenance as a planned system rather than a reaction.
*Shows:* what it takes to keep shared hub equipment usable.
`file` · standard

### Telecoms Engineering *(with IHS Towers)*
**Design connectivity that survives a bad day.**
Design the network for a co-working floor of 60 people: topology, capacity
assumptions, redundancy and failover, and rough monthly cost. State what breaks
first under load, and what you would monitor to see it coming. Then, in half a
page, explain why tower infrastructure is the layer everything above it depends
on — using only publicly available material on how tower operators work.
*Teaches:* designing for degradation, not just for the happy path; reading an
industry from public sources. *Shows:* the infrastructure reality behind a hub
people rely on daily, and why this stream is run with a tower operator.
`file` · complex

> The application form told applicants this stream runs **with IHS Towers**, so
> the partnership is theirs to know. Nothing from IIH's commercial work with them
> is referenced, and none should be — the second half of this task is deliberately
> scoped to public industry material.

---

## Threads worth building more tasks from

All public, all with more in them than one task each:

- **IIH Legal Thursdays** — recurring free founder sessions plus a one-to-one
  legal clinic. Good for events, content, research, admin.
- **IIH × DBN Entrepreneurship Training Programme (ETP 8.0)** — training and
  grants for Kwara MSMEs, publicly announced. Good for entrepreneurship,
  research, writing.
- **InnovateAI Conference / Ilorin Experience Centre** — responsible-AI
  programming. Good for content, e-learning, research.
- **The monthly newsletter and demo days** — founder stories, cohort showcases.
  Good for writing, design, social.
- **The talent survey** — IIH matching people to opportunities by skills and
  interests. Good for research, admin, product.
- **IIH's own products** — the jobs board, link shortener, main site and ORBIT
  itself are all live and public. Good for software, testing, design.

## Open questions before any of this becomes real

1. **The points cap.** See the finding above — it blocks most of these as written.
2. **Peer-dependent tasks.** The Writing profile task needs a peer to interview.
   That works well for cohesion but assumes the communication channel exists.
3. **Equipment-adjacent streams.** Mechanical and Telecoms are written to be
   completable on paper. If those participants will have hub access on Mondays,
   the tasks could get significantly better.
