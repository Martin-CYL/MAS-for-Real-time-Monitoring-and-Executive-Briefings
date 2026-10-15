# Project instructions for Codex

- Project purpose: improve the reusable `us-china-ai-chip-briefing` workflow and its automated quality checks, not polish one dated report.
- Read `TASK_FOR_CODEX.md` for the current work item, and consult `.agents/skills/us-china-ai-chip-briefing/SKILL.md` plus its references and scripts when relevant.
- `examples/V17_reference_2026-10-09.html` is a **historical visual and regression reference**, not current news or an authoritative legal source. Do not overwrite it.
- Preserve the reporting scope: material US-China AI/semiconductor technology developments AND policy/finance/reputation impacts. Avoid mandatory news categories and issue-specific permanent rules.
- Treat link checks, acronym checks, and format checks as mechanical QA, not as proof of factual correctness. Never claim a claim has been verified without source-specific evidence.
- All checks should report PASS / FAIL / UNVERIFIED distinctly. Do not silently pass blocked links or unsupported legal assertions.
- Add regression tests for each checker you change; run them, and report failures and limitations.
- Work only with public information; no bank internal or personal data, no external side effects beyond permitted public-source requests.
- Second round: editorial lessons live in `references/editorial-rules.md`; case follow-ups in `references/active_cases.md`; every report needs `coverage.json` (see `references/coverage.md`). Keep these general; never hard-code a company, list or date into checker logic.
- **Single base:** this merged package (round 3) is the only base. Do not start from an older zip. Keep every existing check (quote/snapshot, risk tiers, sign-off form, coverage sweep, active cases, editorial rules, date checks, safe network layer) unless a task explicitly says to remove one, and add a regression test for any change.
