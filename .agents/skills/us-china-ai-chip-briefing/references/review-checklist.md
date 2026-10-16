# Independent review and final human sign-off

Aim for a short final check after research and correction, not a guaranteed ten-minute review. More uncertainty means more time. Reopen sources rather than trusting the author's `supported` labels or green announcement dots.

**Where to work:** open `signoff.md` from the QA folder. It lists only the high-risk claims, ranked, with source, quote and the reason each was flagged, followed by the events the writer left out. Low-risk claims whose quote was found on the live page have already passed. Tick one box per claim, fill in name, date, decision and `coverage_checked`, then rerun `validate.py --signoff`.

0. **Scan the excluded-events list first (about one minute).** Is any major event missing or wrongly excluded? This is the only place an omitted story becomes visible.

1. Check exact HTML/ledger fingerprints; changes invalidate old reviews. Start with every FAIL, unsupported claim, blocked source and unanswered UNVERIFIED item.
2. Prioritize legal/list/reputational claims. Confirm original instrument, current version, entity identity/aliases, jurisdiction, effective/proposed state, scope, exceptions and dates. An announcement, historical watchlist or accessible URL alone is insufficient.
3. Challenge negative claims: which records were searched, what aliases and date/version, and what the search cannot establish? Bound the language to the search, especially "no listing found" and "no agreement reached".
4. Recompute material statistics; reconcile periods, currency, units, denominators, methods and comparison bases. Company benchmark claims are not independently replicated results.
5. Check contested company responses, attribution, publication date and latest litigation/approval status. Preserve disagreement instead of choosing the convenient side.
6. Scan all material claims without IDs, including summaries, status rows, timelines, chart captions and analytical premises. Check first-use definitions and status legend; preserve material technical competition developments even without a direct banking link.
7. Confirm date/cutoff consistency, no editorial leaks, figures and no cramped mobile/print content. Mechanical warnings are prompts, not conclusive semantic judgments.

Disposition per claim: supported with exact source/anchor/rationale; unsupported (remove/correct); unverified (resolve, explicitly qualify and review, or hold release). A fabricated legal claim cannot become verified because format/link checks passed. Record review separately from the author ledger, with matching hashes.

Final decision: approve / hold / reject; reviewer, date, scope of checks, unresolved items and reason. No automatic publication. Never copy this checklist or reviewer language into the executive HTML. `scripts/validate.py` generates `review_report.md` with the findings and a practical sign-off form.
