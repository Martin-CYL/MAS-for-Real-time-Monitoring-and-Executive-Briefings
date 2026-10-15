# Task: Harden the existing briefing Skill before building the MAS

## Context
This repo holds a prototype skill for recurring Chinese-language executive briefings on US-China AI and semiconductors, with an HTML template and two Python checker scripts. A hand-reviewed V17 example is in `examples/`. Previous revisions exposed repeated defects: broken or guessed links, unexplained acronyms, wrong dates/legal states, stale list membership, ungrounded claims, duplicated caveats, inconsistent status labels, and editorial notes leaking into the final report.

## Your task
**Improve the reusable skill, validator, and evaluation workflow. Do not generate a fresh weekly news report yet.** Start by inspecting the existing files, running the scripts against the V17 reference (offline where possible), and recording the actual baseline findings. Then implement the following, using the simplest maintainable design:

1. **Evidence ledger.** Introduce a machine-readable record for every material factual claim (claim ID, exact claim text, source URL, publication/event dates where available, date checked, quoted/extracted support or anchor, evidence type/status, primary vs secondary, notes on uncertainty). Let the HTML writer refer to claim IDs. Do not confuse a URL existing with proving a claim. Supply one small synthetic example, clearly marked as a fixture.
2. **Link validation.** Improve the checker to verify actual hyperlinks rather than guess them. Report confirmed reachable, confirmed broken, blocked/paywalled, network error, and unchecked separately. A 403/429 must not count as success. Clearly distinguish an HTTP response from content supporting a claim. Make network checks optional and testable with local mocks.
3. **Report validation.** Detect date mismatches across masthead/issue/footer, undefined abbreviations at first use, placeholder leaks, repeated wording, numbering gaps, legend/status mismatches where machine-checkable, and obvious draft/revision-language leaks. Prefer precise warnings to brittle false positives. State which checks need a reviewer.
4. **Tests + evaluation.** Add unit/regression tests with deliberately flawed synthetic reports, including: dead links, 403s, missing first-use definitions, duplicate or missing figure numbers, conflicting dates, and a fabricated legal claim. The fabricated claim must NOT be marked verified merely because checks passed; a human/source verification stage must flag it as unsupported. Document the pass/fail semantics and how to run tests.
5. **Independent review + human sign-off.** Create a short review checklist/report that calls out unsupported legal or list claims, ambiguous negative claims, mismatched statistics, contested company responses, and claims needing human confirmation. The reviewer must not simply trust the author's own labels. Keep it practical for a ~10-minute final sign-off, without promising guaranteed 10-minute review time.
6. **Maintainability and avoiding overfitting.** Keep general editorial principles separate from issue-specific watch-list facts. Distinguish standing domains from active case follow-ups. Preserve the core coverage of major technical developments, even without a direct bank-risk tie, when they materially change the US-China competitive landscape. Avoid baking 1260H or this week's dates into generic checker logic.
7. **Template preservation.** Keep the V17 aesthetic and the responsive/printable HTML template. Only change the template when necessary for reusable evidence labels or validation, and test representative mobile widths.

## Acceptance criteria
- Tests demonstrate that the original injected-failure cases are caught or explicitly escalated to human review, never silently treated as VERIFIED.
- Scripts provide actionable non-zero failure status for definitive test failures; blocked network access is distinguished from a broken URL.
- README includes a single runnable command (or a short sequence) to validate a report and explains dependencies and limitations.
- An example `review_report` shows PASS / FAIL / UNVERIFIED and a concise human sign-off list.
- Produce a change summary: files edited, commands/tests run and results, remaining limitations, and suggested next steps toward a Single-Agent MVP.

Avoid implementing a full multi-agent orchestration platform or connecting bank systems in this first task. First make the reusable skill and QA reproducible.
