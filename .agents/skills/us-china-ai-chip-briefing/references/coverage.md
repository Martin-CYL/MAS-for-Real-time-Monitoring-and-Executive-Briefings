# Coverage sweep (coverage.json)

Purpose: make omissions visible. No check on the report text can see a story that was never written, so the writer lists every candidate event considered, including the ones left out.

## How to do the sweep
1. Before selecting stories, search the window across at least three kinds of sources: wire services / financial press, Chinese-language press or official sites, and US official sites (agencies, Federal Register). Search both "US" and "China" angles.
2. List every event that a well-informed reader might expect to see: at least 8, usually 10–20.
3. Add one entry per active case (`active_cases.md`), with its `case_id`.
4. Decide each: `included`, `background`, `appendix` or `excluded`. Every non-included item needs a one-line reason.

## Format

```json
{
  "window": {"start": "2026-10-02", "end": "2026-10-08"},
  "outlets_searched": ["Reuters", "Caixin", "Federal Register", "MOFCOM", "Company press releases"],
  "candidates": [
    {"event": "US and China extend trade truce to 2027-01-10", "date": "2026-09-23", "side": "both",
     "url": "https://...", "decision": "included", "claim_ids": ["C001", "C002"], "case_id": "A003"},
    {"event": "New open-weight model release by a Chinese lab", "date": "2026-10-05", "side": "cn",
     "url": "https://...", "decision": "excluded", "reason": "Incremental update; no capability change"}
  ]
}
```

`side`: `us`, `cn`, `both` or `other`. `validate.py --coverage coverage.json` checks the sweep is broad, two-sided, follows every active case, gives reasons for exclusions and links included items to ledger claims. The excluded list is printed in `review_report.md` and `signoff.md` so a person can scan it in under a minute.
