# Development workflow

How a task is started, finished, recorded and reviewed, for people and coding agents alike. Engineering and test
requirements are in [AGENTS.md](../AGENTS.md) and are not repeated here.

Sources of truth, one per subject:

| Subject | Document |
|---|---|
| Build, test and merge rules | [AGENTS.md](../AGENTS.md) |
| Current state of each capability | [PROJECT_STATUS.md](PROJECT_STATUS.md) |
| Planned work, owners, acceptance criteria | [ROADMAP.md](ROADMAP.md) |
| Branches and how they relate | [BRANCH_MAP.md](BRANCH_MAP.md) |
| Server environments | [deployment/README.md](../deployment/README.md), [accounts.md](accounts.md) |

## 1. Before a task

1. Read `AGENTS.md` and the relevant rows of `PROJECT_STATUS.md`.
2. Check where you are: `git status`, `git branch --show-current`, `git log --oneline -5`. Keep unrelated
   uncommitted changes; do not stash or discard someone else's work.
3. Find the task ID in `ROADMAP.md` and its acceptance criteria. If the task has none, write them down and agree
   them before starting.
4. Confirm what earlier work actually exists: check the branch and commit, and whether its tests or live checks ran.
   A chat summary, a pushed branch or a passing test is not evidence that something is merged, deployed or verified.
5. Work on the branch the task belongs to (`BRANCH_MAP.md`). Never mix Nex and Skill trees on one branch.

## 2. Hygiene check at completion

Before calling a task done, check and report briefly:

- **Diff:** `git diff` (and `git diff --check`) shows only intended changes.
- **Tests:** the tests `AGENTS.md` requires were run; anything not run is named as not run.
- **Acceptance:** each criterion is met, or the gap is stated.
- **New issues:** blockers or follow-ups found along the way are listed.
- **Records:** `ROADMAP.md` status and `PROJECT_STATUS.md` updated if the state materially changed.
- **Reference:** branch and commit hash given.

Generated code is not a completed task. A task is complete when its acceptance criteria are met and shown.

## 3. Recording progress

- Change a roadmap status only with evidence: a commit, a test run or a live run, with its date.
- Update `PROJECT_STATUS.md` when a capability changes state (implemented, tested, verified, merged), and refresh
  its "Last verified" date.
- Do not add new status or progress files. Record history in commits and pull requests.

## 4. Commits and handoff

- One purpose per commit, with a conventional message. No automated co-author or tool attribution trailers.
- Push feature branches; never force-push, rebase or rewrite shared history. Do not delete or rename branches.
- Merging into `test` or `main` follows `AGENTS.md`: the user confirms, after review.
- A handoff names the branch, commit, what was verified and how, what was not, and the next step.

## 5. Read-only audits

When a team member asks, or after a milestone, review the project without changing anything:

- Does the implementation still meet the original requirements and acceptance criteria?
- Are any roadmap or status entries stale or unsupported by evidence?
- Have feature branches diverged from `main`, or from their matching Nex/Skill branch?
- Did recent changes add unverified assumptions, technical debt or security concerns?

Report findings. An audit does not edit code, documents, Git history or task statuses; changes follow as separate,
agreed tasks.

## 6. Recovering after lost context

When a conversation or an agent's context is lost or compacted, rebuild the task from the repository:

1. Read `AGENTS.md`, this file, `PROJECT_STATUS.md` and the task's roadmap entry.
2. Inspect the branch, working tree and recent commits (`git status`, `git log`, `git diff`).
3. Recover the acceptance criteria from the roadmap entry or the original request.
4. Separate what the repository confirms from what is assumed, and say which is which.

These documents do not give an agent memory; they are only useful if they are read and kept current.

## 7. Escalation

Stop and ask a person before anything that is hard to undo or outside the task:

- merging, deploying, or changing server, credential or repository settings;
- deleting, renaming or force-pushing branches, or rewriting history;
- changing Skill instructions, report templates or validation rules while working on something else;
- spending significantly on live model runs.
