# us-china-ai-chip-briefing

Chinese-language US-China AI and semiconductor executive briefing Skill. The workflow creates a claim-level evidence ledger, preserves the HTML design, separates mechanical/HTTP/source review, and requires human release sign-off. No new weekly report is included in this change.

## Install / use

Place this whole `us-china-ai-chip-briefing` directory, including scripts/references/assets/tests, in the agent's supported Skill directory (for Codex projects: `.agents/skills/`). Read `SKILL.md` when producing or reviewing a briefing. Paths below assume the **Skill directory** is the working directory. The full project package also contains the original V17 and evaluation logs; the standalone package includes those as supporting artifacts. Do not treat the historical reference as news evidence.

## Report language: English

The report is written in English (`assets/template.html`, `references/glossary.md`, `SKILL.md`). Research still
uses Chinese sources; quotes in the evidence ledger stay verbatim in the source language, claim text is English.
The validator is bilingual: English section names, legend labels, first-use explanations ("the US Bureau of
Industry and Security (BIS)"), dates ("October 15, 2026"), the "Data as of" cutoff and attribution ("reportedly")
are recognised, and Chinese reports still validate. The previous Chinese template is kept as
`assets/template.zh.html`. The opt-in staged renderer (`scripts/brief.py`) renders English for runs initialised with
`--lang en` (Chinese stays the default for existing runs). Not yet translated: the QA sidecars (`review_report.md`,
`signoff.md`). Tests: `tests/test_english.py`, `tests/test_multi_agent.py`.

## Multi-agent mode (opt-in)

Used by the Nex briefing workflow (`NEX_BRIEFING_WORKFLOW=1`, see Nex `docs/briefing-workflow.md`); the single-agent
workflow above is unchanged. Each agent works in its own `brief.py` run under `runs/<run-id>/tasks/<task-id>/`.

| File | Use |
|---|---|
| `references/roles/*.md` | Chief Editor, Country Lead, Topic Scout, Reviewer and the shared protocol. Each names the `SKILL.md` and reference sections it needs (`includes:`), which Nex inlines, so rules are not copied |
| `references/roles/categories.json` | Research categories a lead may assign; none is mandatory |
| `references/roles/workflow.json` | Budgets: scouts per lead, concurrency, attempts, rework rounds, cross-border requests, minutes and fresh tokens per role and per run |
| `scripts/merge_runs.py` | Merges accepted task runs into the parent run: new IDs, byte-identical snapshots, provenance, cautious joins, recorded conflicts |
| `scripts/check_handoff.py` | Checks a task's records before handoff (window, decisions, Link/Size/New, quotes, claim kinds, hand edits, narrative, record IDs in shown text, and `STATUS_WORDING`: a claim saying enacted or in force while its event is marked proposed or its quote only shows a proposal) |
| `scripts/check_provenance.py` | Checks every accepted handoff reached the final run unchanged (claims, quotes, events, `proposed`/`unsupported`) |

`brief.py` additions: `init --lang en --no-cases`, `event add --case`, `event decide --link --size --new` (stored as
`assessment`; an explicit decision settles merge conflicts), and `withdraw RUN CID --reason` (a claim leaves the
report but stays in the ledger's `withdrawn` list; its ID is never reused).

## Round 6: scripted news discovery (read first)

`scripts/discover.py --start YYYY-MM-DD --end YYYY-MM-DD --out RUN/discovery` sweeps, in about a minute and with no
model tokens: Federal Register API (BIS and term searches), DOJ press-release API, BIS / Treasury / OFAC / USTR listings,
MOFCOM / State Council / MIIT / CAC listings, FT / SCMP / Nikkei / NVIDIA / AMD / TechCrunch RSS, and date-bounded news
searches (themes, outlets such as Reuters / Bloomberg / FT / Caixin, official domains, and open queries) through Google
News and Bing News RSS. Sources live in `references/discovery_sources.json` (editable; guidance, not a whitelist).

Output: `events.json` (candidate events with every report's link, publisher, date, relevance and access type),
`candidates.md` (section A official items, section B ranked leads) and `discovery_log.json` (every source and its
HTTP status). All of it is discovery metadata, never evidence: aggregator links are not originals, and month-only dates
are flagged rather than completed. Reports are merged only when titles overlap and no distinctive names conflict, so
two different DOJ cases stay separate. `SKILL.md` Step 2.0 runs it first; the rest of the default workflow is unchanged.
Tests: `tests/test_discover.py`.

## Round 5: single-agent baseline (read first)

**Default workflow:** `SKILL.md` as in round 3, checked by the round-4/5 validator (`scripts/validate.py`:
required sections, no "已验证", missing ledger = FAIL, readiness verdict BLOCKED / INCOMPLETE /
READY_FOR_HUMAN_REVIEW / AWAITING_SIGNOFF, ordered FIX lines). In round-5 tests with a lightweight model this
combination produced the most complete reports (see `CHANGE_SUMMARY_round5_single_agent_baseline.md`).

**Opt-in staged pipeline:** `references/staged-pipeline.md` + `scripts/brief.py` (init, fetch, search, event,
add-claim, status, build). Cheaper per run and structurally safe, but reports were thinner in tests. Its run records
are the intended interface for a later multi-agent system:

| File | Written by | Holds |
|---|---|---|
| `run_config.json` | `init` | window (from `--days`/`--end`), timezone, cutoff |
| `sources.json`, `sources/S###.txt` | `fetch` | every page: URL, title, opened/blocked + reason, publication date only when metadata states it |
| `events.json` | `event`, `search` | candidate events (carried-over cases pre-loaded), materiality, include/track/exclude + reason, follow-up, search log |
| `evidence_ledger.json` | `add-claim` | claims whose quote was located in the saved page; fingerprint flags later hand edits |
| `report.json` | agent | analysis only |
| `report.html`, `report_ledger.json`, `coverage.json`, `qa/` | `build` | rendered report, printed claims, coverage export, validation |

`scripts/evidence_tools.py` (register a page, locate a quote, write a complete claim) can also be used on its own.
Evaluation assets: `../../../evaluation/round5/` (frozen corpus, draft reference events, scorer).

## Merged version (round 3)

This version combines round 2 (quote checks, risk tiers, sign-off form, coverage sweep, follow-up cases, editorial rules) with the security-and-dates revision (`check_dates.py`, `safe_http.py`). Additions made during the merge:

| What | File | Why |
|---|---|---|
| Source snapshots | `scripts/save_snapshot.py`, `scripts/check_quotes.py` | Save the page text when you read it. Quotes are then checked against the snapshot offline and behind any proxy. Missing, out-of-folder or altered snapshots FAIL. |
| Proxy allowed by default | `scripts/safe_http.py` | Bank and corporate networks use proxies. Fetching now goes through them, with URL checks on every hop and redirects re-checked. `--strict-network` restores fail-closed refusal. |
| Safe live quote fetches | `scripts/check_quotes.py` | Live quote checks use the same safe network layer as link checks. |
| Date checks wired in | `scripts/check_evidence.py`, `scripts/validate.py` | Ledger chronology errors block auto-pass for that claim; validation clock is shown in the QA report. |

## Second-round additions

| What | File | Why |
|---|---|---|
| Quote check | `scripts/check_quotes.py` | With `--network`, fetches each source and confirms the recorded quote is on the page. Fetched page without the quote = **FAIL** (catches invented quotes). Paywall/PDF = goes to the human list. |
| Red flags | `scripts/check_quotes.py` | Offline: numbers in a claim missing from every quote (亿/万 and month names converted); news sites labelled `official_document`/primary (`references/source_domains.json`); legal/list wording on a claim labelled only `factual`. |
| Risk tiers | `scripts/check_quotes.py`, `check_evidence.py` | Legal, list, negative, statistic, company-response and any flagged claim are **high risk** → human. Low-risk claims whose quote is found → `AUTO_LOW_RISK` PASS, no human needed. |
| Markdown sign-off | `scripts/signoff.py` | `validate.py` writes `signoff.md` with only the high-risk claims, ranked, plus the excluded-events list. Reviewer ticks boxes; fingerprints are written by the script. `--signoff signoff.md` reads it back. |
| Coverage sweep | `scripts/check_coverage.py`, `references/coverage.md` | Writer lists every candidate event (included or excluded, with reason) in `coverage.json`. Checks breadth, US and China sides, every active case followed, included items linked to claims. |
| Continuity | `references/active_cases.md` | The archived watch-list is now 12 recheck questions (A001–A012). |
| Editorial rules | `references/editorial-rules.md` | The selection/background/writing lessons from review rounds, separate from evidence procedure. |
| Fewer false alarms | `scripts/check_report.py` | "（简称 X）" counts as a definition; source link labels, disclaimers and `NT$`-style currency are skipped; overlapping matches deduplicated. |

```sh
python3 scripts/validate.py REPORT.html --ledger LEDGER.json --coverage COVERAGE.json \
  --date YYYY-MM-DD --glossary references/glossary.md --network --output-dir QA
# reviewer edits QA/signoff.md, then:
python3 scripts/validate.py REPORT.html --ledger LEDGER.json --coverage COVERAGE.json \
  --signoff QA/signoff.md --date YYYY-MM-DD --network --output-dir QA
```

Limits: the quote check proves the quote exists on the page, not that the claim follows from it; JavaScript-rendered pages may look like "quote not found" (open them manually and fix the URL or quote); PDFs are not parsed. The coverage check sees only what the writer recorded; a person still needs to skim the excluded list.

## One command to validate a report

Python **3.10+**, standard library only. No pip install, API keys, bank access or third-party Python library is required for report/link/evidence validators or unit tests.

```sh
python3 scripts/validate.py /path/report.html --ledger /path/evidence_ledger.json --date YYYY-MM-DD --glossary references/glossary.md --output-dir /path/qa-output
```

This writes `review_report.json` and `review_report.md`, even when QA rejects a report. Default is offline: actual public URLs are listed **UNCHECKED**, not passed. Add `--network` for HTTP GET checks, and `--review /path/independent_review.json` after independent source review. Never use synthetic `.invalid` fixtures as real evidence or enable public networking for them. HTML/ledger fingerprint changes require new review. `references/evidence-ledger.md` documents the format and JSON schemas.

Individual commands remain available:

```sh
python3 scripts/check_report.py /path/report.html --date YYYY-MM-DD --glossary references/glossary.md
python3 scripts/check_links.py /path/report.html --network --timeout 10
python3 scripts/check_evidence.py /path/report.html --ledger /path/evidence_ledger.json --review /path/independent_review.json
```

Omit `--network` for an offline link inventory. Each checker accepts `--json /path/results.json`.

## Status and exit semantics

| Status | Meaning | CLI exit |
|---|---|---:|
| PASS | This particular performed check succeeded; never blanket factual verification | 0 if no other unresolved results |
| FAIL | Definitive defect: bad dates/IDs/placeholders/numbering, confirmed dead URL, rejected/unsupported claim, stale review | 1, takes precedence |
| UNVERIFIED | Not checked, blocked/error, heuristic requiring review, missing source support or sign-off | 2 if no FAIL |

Link categories: **REACHABLE** means a successful final HTTP response only; **BROKEN** is 404/410 or invalid URL; **BLOCKED** includes 401/402/403/407/429/451 or a recognized access/paywall interstitial; **NETWORK_ERROR** includes transport failure/timeouts and retryable server errors; **UNCHECKED** includes offline mode, unresolved relative links, ambiguous responses and suspected soft errors. A 403/429 cannot pass. A proxy tunnel refusal is BLOCKED, records proxy_http_status separately, and leaves target http_status empty; it is not a response from the source website. Neither an accessible page nor a green announcement dot proves a claim. Relative links are not invented or resolved by guessing. Redirects are followed and their final URL recorded. Other 4xx responses are ambiguous and require review, rather than falsely declaring the page dead.

Standalone `check_report.py` can PASS while a factual claim is unsupported; run the aggregate command and source review for release decisions. Source support/review is **UNVERIFIED by default**. A reviewer must reopen sources, explain entailment, review all unmarked material claims, and sign off independently of the author. Recorded approvals are not authenticated identities; the program is not a legal reasoning or truth engine. Blocked links stay unresolved until rechecked or replaced; a recorded approve does not erase failures.

## Regression tests and evaluation

From the Skill directory:

```sh
python3 -m unittest discover -s tests -v
python3 tests/evaluate_fixtures.py --output-dir fixture-evaluation
```

Tests use synthetic reports, injected responses and a loopback HTTP server; no public network. The evaluation runner returns 0 when the expected injected failures are detected; its generated QA report deliberately says **FAIL**. It never hides the underlying validator's result. The fixtures label fictional sources/dates/author and reviewer records explicitly. Tests cover 404/410, 403/429, network errors, soft-error/paywall responses, redirects, late definitions, dates/cutoffs, numbering, draft leaks, repetition, status legends, stale/self-reviews, human rejection, and fabricated legal assertions. A historical compatibility regression runs if V17 is present; when only a bare Skill folder is copied, it may be explicitly skipped.

Runnable offline example (expected CLI exit **1**):

```sh
python3 scripts/validate.py tests/fixtures/flawed_report.html --ledger tests/fixtures/flawed_ledger.json --review tests/fixtures/flawed_review.json --output-dir flawed-qa
```

Expected: dates/figures FAIL, legal C002 FAIL, late definition/unchecked links/human hold UNVERIFIED, valid traceability/recorded C001 review PASS. `tests/evaluate_fixtures.py` additionally simulates reachable/404/403 sources, clearly labeled **mock** in the QA report. `evaluation/flawed_mock/review_report.md` in the delivery package is a generated example of all three statuses and human sign-off prompts.

## Optional browser layout checks

Only this check needs Python Playwright and Chromium. Install trusted distributions if not present (`python3 -m pip install playwright`, then use an installed Chromium via `--chromium`, or the browser installer supported by Playwright). No browser dependency is imposed on the core Skill.

```sh
python3 scripts/check_layout.py --chromium /usr/bin/chromium --output-dir layout-check
```

It loads synthetic template text in memory, blocks external requests, checks 360/390/768/1320px horizontal overflow, mobile table-card layout and date visibility, checks print-button hiding and a single stylesheet, and exports screenshots/PDF. These are **layout fixtures, not a new briefing**; their duplicate placeholder figure numbers are irrelevant to this isolated geometry test. The synthetic filler is intentionally long. Manual visual review still needs representative final report content and target fonts. Missing Playwright returns 2. Browser launch/permission failures prevent a layout readiness claim.

## Maintainability and Single-Agent MVP

- `SKILL.md`: general workflow and editorial principles.
- `references/watchlist.md`: standing research domains; no mandatory quota or dated case facts.
- `references/active_cases.md`: dated source-specific follow-ups and closure conditions.
- `references/archived_watchlist_2026-10-09.md`: preserved supplied assertions, explicitly unverified historical context.
- `references/glossary.md`: drafting aid, never legal evidence.
- `references/evidence-ledger.md`, schemas, `review-checklist.md`: traceability and independent sign-off contract.
- `scripts/`: reusable mechanical, HTTP, evidence and aggregate checkers; optional browser checker.
- `tests/fixtures`: reusable deliberately wrong inputs and one synthetic ledger/review example.

Next MVP: one agent researches public sources → creates the ledger → writes traceable HTML → runs QA and corrects findings → a person independently reviews sources and signs off. Use a working directory for each issue; retain HTML, ledger, source extracts where permitted, QA results and the review. Compare false positives and actual reviewer corrections before adding permanent rules. No multi-agent orchestration, bank-system integration, automatic publication or current report generation is implemented here.
