# Project status

**Last verified: 2026-10-23.** Update this file when a capability's state changes, not after every task.
Task IDs refer to [ROADMAP.md](ROADMAP.md); branches are described in [BRANCH_MAP.md](BRANCH_MAP.md).

Terms used here:

| Term | Meaning |
|---|---|
| Implemented | Code exists on the named branch. |
| Tested | Named automated tests passed on the named commit, where stated. |
| Verified | Checked end to end in the stated environment, with evidence. |
| Partially verified | Some stages verified; the gap is stated. |
| Merged | On `main`. |
| Deployed | Running on a server. This file does not track deployments; see [deployment notes](../deployment/README.md). |

## Stage

- **Nex web application** (`main`): in internal development and testing. Changes flow `develop-martin` → `test` →
  `main` by pull request.
- **Briefing Skill**: the single-agent workflow is the working baseline (`latest-skill-20261015`), kept separate from
  the Nex tree.
- **Multi-agent briefing** (opt-in): implemented and hardened on feature branches, not merged, not deployed.
  Prepared for a controlled pilot, not production.

## Capabilities

| Capability | Where | State | Evidence |
|---|---|---|---|
| Nex web app, auth, per-user account isolation, sharing | `main` | Merged; tested | CI `check` and `docker` (image build only) passed on `a18ecf2` |
| Single-agent briefing Skill | `latest-skill-20261015` | Implemented; tested | Skill suite: 225 tests OK, 1 skipped, on `aa883ed` (local, 2026-10-22) |
| Multi-agent hierarchy: chief → leads → scouts, merges, provenance, cross-border, draft build | `feature/multi-agent-briefing` + `skill/multi-agent-briefing` | Partially verified | Live run 2026-10-22: plan, leads, scouts, merges and cross-border dispatch ran; stopped by provider 403 before the draft |
| Agent sandbox (per-role Codex permission profiles) | `feature/multi-agent-security-hardening` | Verified on macOS only | Codex 0.163 (Seatbelt): opt-in OS test and pre-run self-test passed; four live run starts on 2026-10-22/23 recorded `sandbox=verified` |
| Role tool limits, refusal of agent-started chats | `feature/multi-agent-security-hardening` | Tested | `briefing-workflow.test.ts` (scripted provider) |
| Token accounting and budgets (best-effort) | `feature/multi-agent-security-hardening` | Verified live | Live run stopped two tasks at their budgets (206,941 of 200,000 and 305,750 of 300,000 fresh tokens) |
| Provider error classification and halt/backoff | `feature/multi-agent-security-hardening` | Tested | `briefing-provider.test.ts`, `briefing-workflow.test.ts`; not yet observed live after the change |
| Independent reviewer | `feature/multi-agent-security-hardening` | Partially verified | Exercised live: 7 structured findings, routed to responsible tasks. Review → rework → release not completed live |
| Rework → second review → final English HTML | both hardening branches | Tested only | Real-Skill integration test with scripted agents; live run ended `blocked` (draft attempts used up during rework) |
| Agent sandbox on Linux / in Docker | — | Not verified | No evidence; the pre-run self-test should refuse to start if it is not enforced |

Test results on the hardening heads (`45ad6d6`, `114ee87`), run locally on macOS on 2026-10-23:

- `bun run check`: passed.
- `bun test --timeout 15000`: 2495 pass, 0 fail, 2 skipped. The skips are opt-in: the real-Skill test needs
  `BRIEFING_SKILL_DIR`; the real OS sandbox test needs `NEX_CODEX_SANDBOX_TEST=1`. With both set, 279 targeted
  tests pass with none skipped.
- Skill suite: 253 tests OK, 1 skipped (the historical V17 example is not in the branch).
- Not run: GitHub CI (it does not run on `feature/*` or `skill/*`), Docker, Linux.

## Known blockers

1. **Report date on past windows.** The Skill validator requires a report to be generated on its report date. A run
   for a window that has already ended, built after midnight in the report's time zone, is always blocked. Run the
   briefing on its report date. (This caused the 2026-10-23 live blocking.)
2. **Linux sandbox evidence.** The production deployment runs on Linux; enforcement there is unverified.
3. **Branch layout.** Nex and the Skill live on unrelated trees, and the multi-agent feature needs matching branches
   from both (see [BRANCH_MAP.md](BRANCH_MAP.md)). There is no agreed way yet to version or install them together.
4. **CI coverage.** The Skill's Python tests and the opt-in integration tests are not in CI.

## Known issues (not blocking)

- An event's status label is set per event, so one official source can mark a media-only detail as "official"
  (found by the live reviewer).
- In the status table, the dot shows legal state and the text shows evidence level, which can read as a mismatch.
- The Skill branch README refers to files not in the branch (`CHANGE_SUMMARY_*.md`, `examples/`, `evaluation/`);
  they belong to earlier delivery packages and are historical references.

## Latest validated references

| Branch | Commit | Validation |
|---|---|---|
| `main` | `a18ecf2` | GitHub CI passed |
| `feature/multi-agent-security-hardening` | `45ad6d6` | Local tests above; live run 2026-10-23 |
| `skill/multi-agent-security-hardening` | `114ee87` | Local Skill suite above |

## Next actions

See [ROADMAP.md](ROADMAP.md), milestone M1: verify the sandbox on Linux, complete one live run through review and
rework on its report date, and decide how Nex and the Skill branches are reviewed and released together.
