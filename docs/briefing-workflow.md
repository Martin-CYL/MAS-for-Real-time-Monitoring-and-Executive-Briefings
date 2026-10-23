# Multi-agent briefing workflow

An opt-in execution mode for the `us-china-ai-chip-briefing` Skill. The single-agent briefing is unchanged and stays
the default; nothing here runs unless the server is started with `NEX_BRIEFING_WORKFLOW=1` **and** a user explicitly
asks for the multi-agent briefing.

## Shape

```
user chat ──briefing_start──▶ Chief Editor (sub-chat, depth 1)
                                ├─ US Lead (depth 2) ──▶ topic scouts (depth 3)
                                ├─ China Lead (depth 2) ──▶ topic scouts (depth 3)
                                ├─ cross-border requests, answered by the other lead in its own chat
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
| `src/server/briefing-contracts.ts` | Zod schemas for the agents' envelopes: `output.json`, `plan.json`, `findings.json` |
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
| `briefing_delegate` | chief → lead; lead → scout | Checks role, plan, budgets; prepares `tasks/<id>/`; starts or queues the agent; `retryOf` (once), `reworkOf` (after review) |
| `briefing_wait` | any parent | Waits on its tasks, merges accepted records into the caller's run, returns outputs or explicit failures |
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

## Agent permissions

Ordinary Nex chats run Codex with `danger-full-access`. Briefing agents do not. Each agent's Codex session gets a
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
  restart recovery with crashes injected at each save point (`fault`).
- `src/server/briefing-budget.test.ts`: the allocation policy over 2,000 generated runs.
- `src/server/briefing-workflow.skill.test.ts`: the same hierarchy through the real Skill scripts (records, merges,
  handoff and provenance checks, English render and validator): a proposal written as enacted is refused, a
  post-handoff edit is refused, review rework is routed to the responsible lead and resubmitted. Skipped unless
  `BRIEFING_SKILL_DIR` points at the Skill.
- `src/server/briefing-sandbox.test.ts`: profiles per role, the exact `thread/start` parameters, session reuse, the
  pre-run check; with `NEX_CODEX_SANDBOX_TEST=1` and `codex` on PATH it runs the real OS sandbox.
- `src/server/briefing-provider.test.ts`: provider error classes and backoff.

Both play the agents by hand. They show the workflow's rules and handoffs, not what a model researches or writes.
