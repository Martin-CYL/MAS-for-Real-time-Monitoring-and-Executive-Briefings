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
| `src/server/briefing-contracts.ts` | Zod schemas for the agents' envelopes: `output.json`, `plan.json`, `findings.json` |
| `src/server/nex-briefing-tools.ts` | The six agent tools |
| `src/server/nex-tools.ts`, `agent.ts`, `server.ts` | Registration behind the flag, wiring, settle/stop hooks |
| `src/server/orchestrator.ts` | Two read-only accessors (`getChatSummary`, `getChatOutcome`) |

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
- Rework is bounded (`max_rework_rounds`); a review that still fails ends the run `escalated` with the open findings.
  Draft attempts, scouts per lead, concurrent scouts, attempts per task, cross-border requests and per-role time are
  budgeted in the Skill's `references/roles/workflow.json`. Time budgets are re-checked every minute while a run is
  active, so a task whose provider request hangs is stopped and recorded as timed out even when no agent is calling
  a tool.
- Final statuses: `ready_for_human_review`, `incomplete`, `escalated`, `blocked`, `failed`, `cancelled`. None of them
  replaces the human sign-off in `qa/signoff.md`.

## Files of a run

`<project>/runs/<run-id>/`: `workflow.json` (state), `workflow.log.jsonl` (one line per transition, also printed as
`[briefing]` server log lines), the chief's records and `report.json`, `report.html`, `qa/` (validator output plus
`workflow_summary.md`), `discovery/`, and `tasks/<task-id>/` for every lead, scout, cross-border reply and review,
each with `assignment.json`, its records, `narrative.md`, `output.json` and `submission.json`.

Directory separation and hash checks keep agents' files apart and make changes visible. They are not a sandbox:
agents run with the provider's normal file access.

## Running

```sh
NEX_BRIEFING_WORKFLOW=1 bun run start:production --host 127.0.0.1 --port 3210 --no-open
```

Install the Skill with multi-agent support where Codex finds it for the project (`.agents/skills/` in the project or
the account's Codex skills directory), then ask in a chat: `/us-china-ai-chip-briefing … in multi-agent mode`.

## Tests

- `src/server/briefing-workflow.test.ts`: real coordinator, store and orchestrator with a scripted provider and a
  stand-in for the Skill scripts. Covers delegation depth, result return, queueing, budgets, refusal, failure, retry,
  timeout, cancellation, cross-border, review/rework bounds, partial runs, restart and tool wiring.
- `src/server/briefing-workflow.skill.test.ts`: the same hierarchy through the real Skill scripts (records, merges,
  handoff and provenance checks, English render and validator), with a seeded post-handoff edit. Skipped unless
  `BRIEFING_SKILL_DIR` points at the Skill.

Both play the agents by hand. They show the workflow's rules and handoffs, not what a model researches or writes.
