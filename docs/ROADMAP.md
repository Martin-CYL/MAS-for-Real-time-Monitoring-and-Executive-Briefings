# Roadmap

The single list of planned work. Current state lives in [PROJECT_STATUS.md](PROJECT_STATUS.md); change a task's
status here when it changes, with evidence. Task IDs are stable: do not reuse or renumber them.

**Status:** Backlog · In Progress · Blocked · In Review · Verified.
Verified needs evidence (a commit plus a test run or live run) that meets every acceptance criterion.
**Owner** is Unassigned until someone takes the task.

## M1: Multi-agent briefing ready for a controlled pilot

| ID | Task | Priority | Status | Owner | Acceptance criteria | Evidence |
|---|---|---|---|---|---|---|
| MAS-01 | Review the multi-agent Nex and Skill branches | High | In Review | Unassigned | Reviewers read `feature/multi-agent-security-hardening` and `skill/multi-agent-security-hardening`; findings are recorded and resolved or deferred | Branches pushed 2026-10-23 (`45ad6d6`, `114ee87`); no PR opened |
| MAS-02 | Complete one live run through review and rework | High | Backlog | Unassigned | On its report date, one run reaches `ready_for_human_review` or `incomplete` after at least one rework round; `qa/signoff.md` produced; usage within budget | 2026-10-23 live run reached the reviewer (7 findings) and ended `blocked`; see PROJECT_STATUS |
| MAS-03 | Verify the agent sandbox on the Linux deployment host | High | Backlog | Unassigned | On the target Linux host or container: `NEX_CODEX_SANDBOX_TEST=1 bun test src/server/briefing-sandbox.test.ts` passes, and a run start logs `sandbox=verified`; if not enforced, the run refuses to start | Verified on macOS only |
| MAS-04 | Decide how Nex and Skill branches are versioned and released together | High | Backlog | Unassigned | A written decision (in this repository) on where the Skill lives, how a Nex commit names the Skill version it needs, and how both are installed on a server | See BRANCH_MAP compatibility notes |
| MAS-05 | Bring the multi-agent feature branches up to date with `main` | Medium | Backlog | Unassigned | `main` merged into the feature branch (no rebase or force-push); `bun run check` and `bun test --timeout 15000` pass | Trial merge onto `a18ecf2` is clean (not tested) |
| MAS-06 | Run CI on the multi-agent branches | Medium | Backlog | Unassigned | A PR (when requested) or CI run shows `check` passing on the feature branch; the Skill's Python suite is run and reported alongside | CI has not run on `feature/*` or `skill/*` |

## M2: Research quality

| ID | Task | Priority | Status | Owner | Acceptance criteria | Evidence |
|---|---|---|---|---|---|---|
| RQ-01 | Per-claim status labels | Medium | Backlog | Unassigned | A detail supported only by media is never labelled as an official announcement, even when its event has an official source; regression test added | Found by the live reviewer, 2026-10-23 |
| RQ-02 | Clarify the status-table legend | Low | Backlog | Unassigned | The status dot and the evidence text in one cell cannot read as contradictory; existing report format kept | Found by the live reviewer, 2026-10-23 |
| RQ-03 | Compare single-agent and multi-agent briefings on the same window | Medium | Backlog | Unassigned | Both workflows run on one window; coverage, claims, validator readiness, time and tokens recorded; a person judges a sample of claims | A partial comparison from 2026-10-22 exists outside the repository; no reference event set |

## M3: Operations

| ID | Task | Priority | Status | Owner | Acceptance criteria | Evidence |
|---|---|---|---|---|---|---|
| OPS-01 | Validate the Docker image beyond the CI build | Medium | Backlog | Unassigned | The checks listed in [deployment/README.md](../deployment/README.md) pass on the development host | `AGENTS.md`: Docker validation deferred until server deployment |
| OPS-02 | Add the Skill's Python tests to CI | Low | Backlog | Unassigned | Proposal reviewed first: CI changes are out of scope for documentation work | — |
