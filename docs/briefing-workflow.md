# Multi-agent briefing workflow

An opt-in execution mode for the `us-china-ai-chip-briefing` Skill. The single-agent briefing is unchanged and stays
the default; nothing here runs unless the server is started with `NEX_BRIEFING_WORKFLOW=1` **and** a user explicitly
asks for the multi-agent briefing.

## Shape

```
user chat ──briefing_start──▶ Chief Editor (sub-chat, depth 1)
                                ├─ US Lead (depth 2) ──▶ topic or source-lane scouts (depth 3)
                                ├─ China Lead (depth 2) ──▶ topic or source-lane scouts (depth 3)
                                ├─ cross-border requests, answered by the other lead in its own chat
                                ├─ gap round: the same leads reopened for gaps found by rule (+ gap scouts, depth 3)
                                ├─ Independent Verifiers (depth 2, before the first draft, when the Skill enables them)
                                └─ Independent Reviewer (depth 2, fresh chat per review round)
```

Every agent is an ordinary Nex sub-chat created through `ChatOrchestrator`, running on the configured provider
(Codex App Server by default). Nex's own limits apply unchanged: sub-chats nest at most `MAX_CHAT_DEPTH = 3` below
the user's chat and at most `MAX_LIVE_CHATS = 8` run under one conversation. The hierarchy uses exactly the three
levels; scouts beyond the run's concurrency budget are queued by the workflow and started as slots free.

## Pieces

| File | Role |
|---|---|
| `src/server/briefing-workflow.ts` | Run state, task rules, queue, acceptance, merges, draft/review/rework, final status |
| `src/server/briefing-sandbox.ts` | Per-role Codex permission profiles and the pre-run enforcement check |
| `src/server/briefing-provider.ts` | Provider error classes and backoff |
| `src/server/briefing-contracts.ts` | Zod schemas for the agents' envelopes: `output.json` (with a lead's `gap_results`), `plan.json`, `gap_plan.json`, `findings.json`, `verification.json` |
| `src/server/nex-briefing-tools.ts` | The six agent tools |
| `src/server/nex-tools.ts`, `agent.ts`, `server.ts`, `codex-app-server.ts` | Registration behind the flag, role tool allowlist, confined Codex sessions, wiring |
| `src/server/orchestrator.ts` | Read-only accessors (`getChatSummary`, `getChatOutcome`, `getUsageSince`) and `createChat`'s `onCreated` |

The Skill supplies the domain side: role instructions (`references/roles/*.md`, which name the sections of
`SKILL.md` and the references each role needs), research categories and budgets (`references/roles/*.json`), the
record keeper (`scripts/brief.py`, now able to render the English template), `merge_runs.py`, `check_handoff.py`,
`check_provenance.py` and the existing validator.

## Tools

| Tool | Caller | Effect |
|---|---|---|
| `briefing_start` | user's chat | Locates the Skill, `brief.py init` (English), optional discovery sweep, starts the Chief Editor |
| `briefing_delegate` | chief → lead; lead → scout | Checks role, plan, budgets; prepares `tasks/<id>/`; starts or queues the agent; `retryOf` (once), `reworkOf` (after review); in lane mode `lane`, `categories` and `primaryLeads` |
| `briefing_wait` | any parent | Waits on its tasks, merges accepted records into the caller's run, returns outputs or explicit failures; in lane mode a lead also gets `primaryLeads` |
| `briefing_submit` | the task's own chat | Validates the envelope and runs `check_handoff.py`; plan and draft for the chief; findings for the reviewer |
| `briefing_cross_border` | chief | Sends an evidence-scoped question (event IDs, scope, evidence required) to the other lead as a task |
| `briefing_status` | anyone in the run | Stage, budgets, tasks, chats |

## Rules the workflow enforces

- A task finishes only through an accepted submission. A chat that ends without one, fails, times out or is stopped
  is recorded as `failed` or `cancelled` with the reason; a lead cannot hand off without naming failed scouts in
  `gaps`, and a draft without both country leads needs an explicit `partialReason` and ends `incomplete`.
- Accepted records are frozen by SHA-256 (`submission.json`) and merged upward with `merge_runs.py` only while the
  receiving agent is blocked in a briefing tool, so no two writers share a run directory. Claim text, quotes and
  snapshots are never rewritten; duplicates are joined with the more cautious `proposed`/materiality values, and
  disagreements are left as `merge_conflicts` for the owner to settle.
- A draft is accepted only if the chief's records pass, `check_provenance.py` finds no lost or altered evidence and no
  record changed after its handoff, and the Skill's renderer and validator do not block it. The reviewer then runs in
  a fresh chat; its findings must name claims/events that exist and are routed to the responsible tasks by provenance.
- Drafts, reviews and rework are counted apart. A draft refused before validation (still-running tasks, a review in
  progress, no budget for the review) costs nothing; a validation refusal uses one of the current cycle's
  `max_draft_rejections`, and the first draft and each rework round are separate cycles. Each accepted draft is a
  numbered version recording the claims it printed; a later version may drop or reword one only by withdrawing it,
  by a review finding naming it, or by excluding its event (`DRAFT_CLAIM_DROPPED`, `DRAFT_CLAIM_CHANGED`).
- Review findings have a lifecycle in `workflow.json` `findings`: key (`review-1/R001`), severity, target, evidence,
  responsible tasks, correction, status (`open`, `in_rework`, `resolved`, `unresolved`, `escalated`) and history.
  Each later reviewer must assess every earlier blocker and major finding in `previous`; only a reviewer can resolve
  one, a `pass` with one unresolved is refused, and a run never ends `ready_for_human_review` with one open.
- Rework is bounded (`max_rework_rounds`); a review that still fails ends the run `escalated` with the open findings.
  A reviewer that fails or times out is relaunched once on the same version (`max_review_attempts`), then the run is
  escalated rather than left waiting. Scouts per lead, concurrent scouts, attempts per task, cross-border requests and per-role time are
  budgeted in the Skill's `references/roles/workflow.json`. Time budgets are re-checked every minute while a run is
  active, so a task whose provider request hangs is stopped and recorded as timed out even when no agent is calling
  a tool.
- Final statuses: `ready_for_human_review`, `incomplete`, `escalated`, `blocked`, `failed`, `cancelled`,
  `budget_exhausted`, `provider_unavailable`. None of them replaces the human sign-off in `qa/signoff.md`.

## Gap round

When the Skill's `workflow.json` sets `gap_round.enabled`, the chief's first draft submission runs a gap check before
anything else. The submission is not counted, and older Skills and saved runs are unaffected. The design and how it
is to be evaluated: [briefing-gap-round-design.md](briefing-gap-round-design.md).

- **Listing.** Once both leads have handed in, the controller merges their records into the chief's and runs
  `brief.py gaps` with the leads' directories. The Skill's rules list what is missing: an active case the plan gave a
  side with no event that has a claim, a research origin or a reason (`case_unfollowed`); a side with no new event
  (`side_empty`); a high-materiality shown event without a primary source (`single_source`); a top or official discovery
  candidate whose pages are nowhere in the records (`discovery_unhandled`); a lead's own gaps and open questions
  (`declared`); a planned category with no event, once events carry `--category` (`category_empty`). At most
  `max_gaps_listed`, highest priority first; the rest are counted. The controller writes `RUN/gaps.json`; no gap: the
  draft goes straight on to verification. The chief does not choose the gaps.
- **Decision.** The chief writes `gap_plan.json` with one decision per gap and submits it (`briefing_submit`, kind
  `gap_plan`). A skip needs a reason; at most `max_gaps_pursued` are pursued; a gap is routed to the lead of its side,
  or of the lead its event came from, and a gap with neither needs a `side`. Nothing pursued: no lead is reopened.
- **Round.** The controller reopens each lead with pursued gaps, the way rework does: the chat keeps its context, the
  lead gets the gap tickets, its own allowance and time (`lead_fresh_tokens`, `lead_minutes`) counted from the
  reopening, and may delegate up to `max_gap_scouts_per_lead` gap scouts (`briefing_delegate` with `gap`; their own cap
  and time, `scout_fresh_tokens` and `scout_minutes`, apart from the first-round scout budget). The IDs of its events
  and claims and the number of logged searches at the reopening are saved as its baseline. Cross-border requests wait
  until the round ends. A lead's resubmission must report every gap it was given in `gap_results`: `filled` (with the
  event or claim IDs), `searched_none` (at least two searches) or `not_reached` (with a reason).
- **Check.** Once every reopened lead has ended, `brief.py gap-check` tests each report against the lead's records
  and baseline: `filled` holds only for new records of the right kind (a case event for a case gap, a new primary
  source on a media-only event, a page of the candidate for a discovery gap); otherwise `filled_unconfirmed`.
  `searched_none` needs two searches logged since the reopening; otherwise `not_searched`. A lead that does not hand in
  again leaves its gaps `not_reached`; its first-round hand-in is restored if its records are unchanged, and otherwise
  the research it handed in before the round, already merged into the chief's records, still counts as that side's
  input. The outcomes go to `RUN/gap_report.json`, which agents can read and cannot write. The chief is told once;
  the next draft goes on to verification, and the reviewer's assignment carries the round's summary.
- **Sign-off.** `qa/signoff.md` lists the round: skipped or unfilled active cases and empty sides first, then every
  other gap with its outcome.
- **Budget.** `reserve_fresh_tokens.gap_research` is held back from the first round of research and released when the
  gap check runs. If a reopened lead cannot be afforded, its gaps are recorded as `not_reached` with the reason.

## Independent verification

When the Skill's `workflow.json` sets `verification.enabled` and ships `references/roles/verifier.md`, the chief's
first draft submission starts independent verification instead of building the draft. The submission is not
counted, and older Skills and saved runs are unaffected. The design and how it is to be evaluated:
[briefing-verifier-design.md](briefing-verifier-design.md).

- **Selection.** The Skill picks the claims (`brief.py verify-select`): high-risk kinds by the validator's risk tier,
  and the claims that decide a shown event's status label, highest risk first, up to `max_claims`. The chief does not
  choose them.
- **Blindness.** Each verifier gets only what the report asserts: claim text, kinds, the status a reader is told, and
  the event's title and date. Its profile (`nex-briefing-verifier`) may write its own directory and read the Skill,
  and nothing else of the run, so it cannot read the author's sources, ledgers or narratives. Container mode does not
  enforce this (see the last section).
- **Hand-in.** A verifier records its own sources and quotes with `brief.py`, then writes `verification.json`:
  `confirmed`, `contradicted`, `scope_differs`, `status_differs` or `not_found`, each but `not_found` backed by its own
  recorded claims (`check_handoff.py --role verifier`).
- **Outcome.** The controller writes `RUN/claim_verification.json`, which agents can read and cannot write:
  - `independent` (confirmed with a primary source), `media_only`, `not_found`, the three disputes, or `unverified`
    (the verifier failed, timed out, or the run could not afford it);
  - each dispute becomes a major finding `verify-N/V001`, routed by provenance like a review finding.
- **The chief's options.** The chief is told about disputes once. It may send one round of rework on them before the
  draft (`max_rework_rounds`), or submit again and take them to review open. The reviewer must assess them like any
  earlier finding, so an unresolved dispute keeps the run from `ready_for_human_review`.
- **The report.** A story whose legal or list claim the check could not support is labelled with the grey "No
  supporting source located" marker instead of "Official or company announcement". The same marker now shows status
  table rows with no located source, which used to borrow the amber media-report marker. The sign-off sheet shows each
  claim's check.
- **Budget.** Verifiers have their own cap (`task_fresh_tokens.verifier`), a reserve (`reserve_fresh_tokens.verification`)
  that research may not touch, and must leave a review and its rework affordable. If they cannot, verification is
  skipped with the reason and every selected claim stays `unverified`.

## Source lanes

When the Skill's `workflow.json` sets `scout_mode: "lane"` and ships `references/roles/lanes.json` and
`references/roles/source-scout.md`, leads split their scouts by source instead of by topic. Otherwise (the default,
older Skills and saved runs) scouts are delegated by topic as before. The design and how it is to be evaluated:
[briefing-source-lanes-design.md](briefing-source-lanes-design.md).

- **Lanes.** `lanes.json` lists them (the Skill ships `official`, `company`, `media`) with the evidence types each may
  record. A lead's assignment carries `scout_mode` and the lanes. In lane mode every new scout names a `lane`; its
  `topic` defaults to the lane's title, and the same topic in another lane is a separate task.
- **Instructions.** A lane scout gets `source-scout.md` with only its own `## Lane: <id>` section (and the shared
  parts), not `topic-scout.md`.
- **Check.** Its assignment carries `lane` and `evidence_types`, and Nex runs `check_handoff.py --lane <id>`, which
  refuses a claim of another type (`LANE_EVIDENCE_TYPE`) or an `official_document` from a host the Skill does not list
  as official (`LANE_SOURCE_HOST`). The labels a report shows (official / company / media) therefore come from which
  lane found the evidence, not from a scout's own `--type`.
- **Budget.** `token_budget.lane_fresh_tokens` caps each lane's scouts; a lane without a cap gets the scout cap. The
  reserve rule is unchanged: a lower cap only lowers what a running scout holds against the reserve.
- **Primary leads.** A media scout's `output.json` may list `primary_leads` (its event, the agency, the document to
  look for). After the merge, `briefing_wait` returns them to the lead as `primaryLeads`, numbered `L001…` and
  translated to the lead's own event IDs through `merge_log.json`, with each lead's follow-up and its outcome.
- **Follow-up.** The lead sends chosen leads to a scout of a follow-up lane (`official` or `company`,
  `primaryLeads: ["L001"]`). Its assignment holds the lead's event title, date and side; the scout records the primary
  claim on an event with exactly those, so `merge_runs.py` joins it to the reported event, and reports `found` or
  `not_found` per lead in `lead_results` (checked by `check_handoff.py`). A lead already followed up is not sent
  twice unless that follow-up failed.
- **Unhandled leads.** A lead's handoff is accepted with a `PRIMARY_LEAD_UNHANDLED` warning, which reaches the chief,
  for each lead no follow-up took and the lead's `gaps` do not name.
- **Summary.** `qa/workflow_summary.md` adds per lane: scouts, fresh tokens, events, claims and merge conflicts; the
  events in leads' records found by two or more lanes; and leads raised, followed up, found and not found.
- **With the gap round.** A gap scout in lane mode also names a lane (the gap's `suggested_source` says which). It
  gets that lane's instructions and handoff check, but the gap round's cap and time, and it counts against the gap
  scouts, not the first-round lane scouts.

## Agent permissions

The filesystem guarantees and pre-run probe below describe the default `sandbox` mode.
For the explicit test-only `container` option, see the final section; those filesystem guarantees do not apply.

Ordinary Nex chats run Codex with `danger-full-access`. In sandbox mode, each briefing agent's Codex session gets a
permission profile for its role, passed as thread config overrides (`default_permissions`, `permissions.<profile>`),
and Codex enforces it with the OS sandbox (Seatbelt on macOS). Nothing is written to the user's Codex config.

| | Writes | Reads denied (besides credentials) | Nex tools |
|---|---|---|---|
| Scout | its own `tasks/<id>/` | the rest of the run and project, except `discovery/` and the Skill | `briefing_submit`, `briefing_status` |
| Lead | its own directory (cross-border replies are nested in it) | other runs and project files | + `briefing_delegate`, `briefing_wait` |
| Chief | the run root, except `tasks/` (read-only) and controller files | other runs and project files | + `briefing_cross_border` |
| Reviewer | its own `tasks/review-N/` | other runs and project files | `briefing_submit`, `briefing_status` |

For every role:

- Denied reads and writes: `workflow.json`, `workflow.log.jsonl`, Nex's data directory, `CODEX_HOME`, `~/.codex`,
  `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config`, `~/.gitconfig`, `~/.git-credentials`, `~/.netrc`, `~/.nex*`,
  `~/Library/Keychains` and similar (`HOME_DENY` in `briefing-sandbox.ts`). `assignment.json` and `submission.json` are
  read-only. Network stays on for research.
- Codex features that act outside the shell sandbox are off: computer use, browser use, connectors (`apps`),
  plugins and native sub-agents. The shell environment drops variables matching `*TOKEN*`, `*SECRET*`, `*KEY*`,
  `*PASSWORD*`, `GH_*`, `GITHUB_*`, `NEX_*`, and Git is pointed at no global or system config.
- Nex tools outside the role's list are refused in `NexToolRuntime`, whatever the provider lists: an agent cannot
  message other chats, schedule work, start chats, send attachments or generate images. There is no approval path
  inside a run; such operations are denied.
- An agent's task is registered before its chat's first turn (`createChat`'s `onCreated`). A chat an agent creates
  outside the workflow is refused before it runs, and briefing agents run only on Codex.
- Before a run starts, `verifySandbox` runs a scout's profile through `codex sandbox` against canaries (own directory
  writable; another task directory, the workflow state and Codex credentials not). If the host does not enforce it,
  the run does not start.

Limits: reads outside the denied paths are allowed, so an agent can still read system files and unlisted parts of the
user's home. Network egress is not restricted by domain. The controller's own Python checks and merges run outside
the sandbox on agent-written JSON (as data, with `python3 -I`). Enforcement was verified on macOS (Codex 0.163,
Seatbelt); on Linux it depends on that host's Codex sandbox and is checked by `verifySandbox` at each run start.

## Tokens, providers and statuses

Usage is read from the provider's per-request reports in each agent's transcript and attributed to the task that
chat was working on: input, cached input, output and reasoning tokens per task and per run (`briefing_status`,
`qa/workflow_summary.md`). Budgets count fresh tokens (uncached input + output) and live in the Skill's
`workflow.json` (`token_budget`). The allocation policy is `src/server/briefing-budget.ts`:

- A reserve (`reserve_fresh_tokens`: synthesis, review, rework) is held back from research. A new lead or scout
  starts only if, with every running agent spending its whole cap plus `in_flight_margin`, the reserve stays
  untouched. A review may use the reserve; rework must leave room for a second review.
- A refused start says why, with figures, and whether waiting for running agents can help; a queued task the run can
  no longer afford is cancelled with that reason instead of waiting for ever.
- A research agent at `wrap_up_at` of its cap, or all of them when the research pool runs short, gets one steer
  message to stop searching and hand in what it has.
- A lead reopened for rework gets `rework_fresh_tokens`, counted from the reopening.
- Past a task budget the task is stopped; past the run budget every agent is stopped and the run ends
  `budget_exhausted`.

Checks run after each tool call and every minute, and a request in flight is invisible until it ends, so the budgets
are best-effort ceilings, not hard caps. `briefing_status` shows the plan (`budgetPlan`) and the controller's own
cost (`controller`: reconciles, Skill-script calls and their time).

## Restarts and repeated calls

State is saved before each external effect and after each acceptance, so a restart finds the run as the agents last
saw it. A task's launch is saved before its chat exists and again, with the chat ID, before its first message. After
a restart a task whose launch was interrupted is running if its chat was recorded (the first message is sent then if
it never was), and otherwise fails as "launch interrupted": it is not relaunched behind anyone's back, and its
requester may retry it. A chat named like a briefing agent but not recorded is refused, never run unconfined. An
accepted review whose outcome was not yet saved is decided on load; finalising twice changes nothing. A repeated
delegate call for the same scout topic returns the existing task. `merge_runs.py` replaces its four files as one step
and takes over a lock left by a dead process.

A turn that ends on a provider error is classified from its message and, where Nex knows it, the account's usage
window: `auth`, `forbidden`, `quota`, `rate_limit`, `transient` or unknown. A 403 is `forbidden`, not quota, unless the
window is full. `auth`, `forbidden` and `quota` halt the run's new starts and retries; `rate_limit` and `transient`
back off (1, 2, 4… up to 15 minutes). A chief lost to a provider error ends the run `provider_unavailable`.

## Files of a run

`<project>/runs/<run-id>/`: `workflow.json` (state), `workflow.log.jsonl` (one line per transition, also printed as
`[briefing]` server log lines), the chief's records and `report.json`, `report.html`, `qa/` (validator output plus
`workflow_summary.md`), `discovery/`, and `tasks/<task-id>/` for every lead, scout, cross-border reply and review,
each with `assignment.json`, its records, `narrative.md`, `output.json` and `submission.json`.

Directory separation and hash checks keep agents' files apart and make changes visible; the OS sandbox described
above is what confines the agents. Records a task changes after its acceptance are not merged: the task fails with
the changed files named.

## Running

```sh
NEX_BRIEFING_WORKFLOW=1 bun run start:production --host 127.0.0.1 --port 3210 --no-open
```

Install the Skill with multi-agent support where Codex finds it for the project (`.agents/skills/` in the project or
the account's Codex skills directory), then ask in a chat: `/us-china-ai-chip-briefing … in multi-agent mode`.

## Tests

- `src/server/briefing-workflow.test.ts`: real coordinator, store and orchestrator with a scripted provider and a
  stand-in for the Skill scripts. Covers delegation depth, result return, queueing, budgets, refusal, failure, retry,
  timeout, cancellation, cross-border, review/rework bounds and the review lifecycle, partial runs, tool wiring, and
  restart recovery with crashes injected at each save point (`fault`), the gap round (listing, decisions, reopened
  leads, gap scouts and their limits, required gap results, checked outcomes, a lead that does not hand in again, no
  gap or every gap skipped, the round's allowance and reserve, older Skills, a crash after a reopening),
  independent verification (blind assignment, disputes to findings, pre-draft rework, failed or unaffordable
  verifiers, older Skills), source lanes (lane choice and instructions, per-lane caps and checks, primary leads to
  follow-ups, unhandled-lead warnings, topic mode and older Skills), and a gap scout in lane mode.
- `src/server/briefing-budget.test.ts`: the allocation policy over 2,000 generated runs.
- `src/server/briefing-workflow.skill.test.ts`: the same hierarchy through the real Skill scripts (records, merges,
  handoff and provenance checks, English render and validator): claims are verified by agents with their own records,
  a proposal written as enacted is refused, a post-handoff edit is refused, review rework is routed to the
  responsible lead and resubmitted; a gap round on the real `brief.py gaps` and `gap-check` (unfollowed cases, a
  media-only event, an empty category; a filled case, a search without result, a "filled" the records do not show);
  and, in lane mode, an official scout recording a news report is refused while a media lead followed up by the
  official lane joins the reported event in the lead's records. Skipped unless
  `BRIEFING_SKILL_DIR` points at the Skill.
- `src/server/briefing-sandbox.test.ts`: profiles per role, the exact `thread/start` parameters, session reuse, the
  pre-run check; with `NEX_CODEX_SANDBOX_TEST=1` and `codex` on PATH it runs the real OS sandbox, including a check
  that a verifier cannot read the author's records.
- `src/server/briefing-provider.test.ts`: provider error classes and backoff.

Both play the agents by hand. They show the workflow's rules and handoffs, not what a model researches or writes.

## Explicit container execution (test deployments only)

`NEX_BRIEFING_EXECUTION_MODE` accepts `sandbox` (default) or `container`.
Invalid values fail startup. This is a server setting, not a prompt or tool argument.
Sandbox mode retains the pre-run enforcement probe and refuses failed checks.
Container mode deliberately does not invoke that probe and explicitly selects
Codex `danger-full-access` inside the outer container. It is never an automatic
fallback. It retains role-specific Nex tool allowlists, disabled Codex features,
working directories and shell environment filtering. Filesystem permission
profiles are not installed in container mode.

There is **no per-task OS filesystem or network isolation** in container mode.
Agents can access files readable/writable by their container user, including
mounted data and credential files. Tool allowlists and environment filtering do
not prevent shell access to such files. Controller state and evidence integrity
are no longer protected against direct shell writes; provenance checks alone do
not restore this boundary. Deployment must use a dedicated test environment,
non-root containers, exclusive data mounts, no Docker socket or privileged mode,
and appropriate network/resource limits. The application does not verify the
outer container boundary or claim a successful sandbox check.

Each run persists its execution mode; older runs default to sandbox. Agent
launch/resume refuses a mismatch with the server mode: start a new run after
changing modes. Summaries expose explicitly disabled isolation. Do not resume
these runs in an older application version without assessing compatibility.
Skills that claim an OS sandbox must be reviewed separately before live testing.
This change does not update Skill sources or provision a server environment.

Deployment: build and test a candidate, deploy its exact SHA/image digest only
to the new test environment, then replay the complete briefing with real Codex.
Verify cancellation, retry, output delivery and isolation from other environments.
Back up persistent data/config and retain the previous image. Rollback requires
checking persisted runs and stopping active tasks; changing the mode is not a
substitute for restoring compatible application/config versions.
