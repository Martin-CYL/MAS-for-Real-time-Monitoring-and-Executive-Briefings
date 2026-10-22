# Branch map

What each remote branch is for and how the branches relate. Commits and merge bases were read from `origin` on
2026-10-23; recheck with the commands at the end before relying on them.

## Two separate file trees

The repository holds two unrelated layouts:

- **Nex** (the web application) lives on `main`, `test`, `develop-martin` and the `feature/*` branches.
- **The briefing Skill** (`.agents/skills/us-china-ai-chip-briefing/`) lives on `latest-skill-20261015` and the
  `skill/*` branches. Commit `0a3c43d` on `latest-skill-20261015` replaced the whole Nex tree with the Skill project,
  so those branches contain no Nex code, and Nex branches contain no Skill.

> **Never merge a `skill/*` branch or `latest-skill-20261015` into `main`, `test` or a `feature/*` branch.** Git sees
> the Skill tree as deleting the application: a merge would remove about 660 Nex files. The Skill is installed into
> a Codex skills directory or a project's `.agents/skills/` (see [deployment notes](../deployment/README.md)), not merged.
> None of the Skill branches carries a `LICENSE` file.

## Branches

| Branch | Head | Contains | Based on | Merged into `main` | Purpose |
|---|---|---|---|---|---|
| [`main`](https://github.com/Martin-CYL/MAS-for-Real-time-Monitoring-and-Executive-Briefings/tree/main) | `a18ecf2` | Nex | — | — | Accepted Nex code. Changes arrive by PR from `test`. |
| [`test`](https://github.com/Martin-CYL/MAS-for-Real-time-Monitoring-and-Executive-Briefings/tree/test) | `839fbbb` | Nex | — | yes (`a18ecf2`) | Integration before `main`; PRs from `develop-martin`. |
| [`develop-martin`](https://github.com/Martin-CYL/MAS-for-Real-time-Monitoring-and-Executive-Briefings/tree/develop-martin) | `1417d09` | Nex | — | yes, via `test` | Day-to-day Nex development. |
| [`latest-skill-20261015`](https://github.com/Martin-CYL/MAS-for-Real-time-Monitoring-and-Executive-Briefings/tree/latest-skill-20261015) | `aa883ed` | Skill | `main` at `b21c551`, then tree replaced | no (must not be) | Latest single-agent briefing Skill. |
| [`skill/multi-agent-briefing`](https://github.com/Martin-CYL/MAS-for-Real-time-Monitoring-and-Executive-Briefings/tree/skill/multi-agent-briefing) | `c33f651` | Skill | `latest-skill-20261015` (`aa883ed`) | no (must not be) | Skill side of the multi-agent briefing: role files, merge and handoff/provenance checks, English renderer. |
| [`skill/multi-agent-security-hardening`](https://github.com/Martin-CYL/MAS-for-Real-time-Monitoring-and-Executive-Briefings/tree/skill/multi-agent-security-hardening) | `114ee87` | Skill | `skill/multi-agent-briefing` (`c33f651`) | no (must not be) | Stricter handoff checks (`STATUS_WORDING`, report-date tampering) and token budgets. |
| [`feature/multi-agent-briefing`](https://github.com/Martin-CYL/MAS-for-Real-time-Monitoring-and-Executive-Briefings/tree/feature/multi-agent-briefing) | `984e630` | Nex | `main` at `efd7cbc` | no | Opt-in multi-agent briefing workflow (`NEX_BRIEFING_WORKFLOW=1`). |
| [`feature/multi-agent-security-hardening`](https://github.com/Martin-CYL/MAS-for-Real-time-Monitoring-and-Executive-Briefings/tree/feature/multi-agent-security-hardening) | `45ad6d6` | Nex | `feature/multi-agent-briefing` (`984e630`) | no | Agent sandboxing, role tool limits, token budgets, provider-error handling. |
| `docs/repository-hygiene` | (this branch) | Nex docs only | `main` at `a18ecf2` | no | Repository documentation. |

`feature/*` and `skill/*` branches are pushed for review. None is merged into `main` or `test`, and none is deployed.

## History

```
main ──b21c551──────efd7cbc────────────a18ecf2        (test and develop-martin merged in by PR)
         │             │
         │             └─ feature/multi-agent-briefing 984e630
         │                  └─ feature/multi-agent-security-hardening 45ad6d6
         │
         └─ latest-skill-20261015: 0a3c43d (tree replaced by the Skill) ─ aa883ed
              └─ skill/multi-agent-briefing c33f651
                   └─ skill/multi-agent-security-hardening 114ee87
```

## Merge and compatibility notes

- `feature/multi-agent-briefing` and `feature/multi-agent-security-hardening` are 3 commits behind `main`
  (`1417d09` and two merges). A trial merge (`git merge-tree`) onto `a18ecf2` is clean; it has not been tested.
- The `feature/*` branches need the matching `skill/*` branch: Nex refuses to start a multi-agent run unless the
  Skill it finds has `scripts/merge_runs.py` and `references/roles/`. The hardening branches belong together:
  `feature/multi-agent-security-hardening` expects the `token_budget` and handoff checks of
  `skill/multi-agent-security-hardening`.
- CI (`.github/workflows/ci.yml`) runs on pushes to `main` and `test` and on pull requests. It has not run on any
  `feature/*` or `skill/*` branch, and it never runs the Skill's Python tests.
- Without `NEX_BRIEFING_WORKFLOW=1` the multi-agent code is inactive; with the variable unset, Nex behaves as on `main`.

## Recheck

```sh
git fetch --prune
git log -1 --oneline origin/<branch>
git merge-base origin/main origin/<branch>
git rev-list --left-right --count origin/main...origin/<branch>   # behind, ahead
git branch -r --merged origin/main
```
