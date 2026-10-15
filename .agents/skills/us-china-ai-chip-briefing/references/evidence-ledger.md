# Evidence ledger and independent review

This is a traceability record, not an automated fact-checker. Standard-library Python validates required fields and references; the adjacent JSON schemas describe the interchange format. Source text must be opened and read. Merely inserting text in `quote` does not verify it.

## Ledger v1

Use `schema_version: 1`, explicit `fixture` boolean, `author`, `report_date` (ISO date), and `claims` array. Synthetic examples in `tests/fixtures` use `.invalid` URLs and fictitious 2030 dates; they are **fixtures, never factual sources or real approvals**. Do not run public networking against them.

Each claim:

| Field | Requirement |
|---|---|
| `id` | C plus at least three digits, unique in ledger |
| `text` | Exact proposition as written inside its HTML `data-claim-id` marker |
| `kinds` | One or more: factual, technical, legal, list, negative, statistic, company_response |
| `author_status` | supported / unsupported / unverified; author's assessment only, never VERIFIED |
| `event_date` | YYYY-MM-DD or null if unknown; future planned event date is allowed |
| `uncertainty` | Scope limits, disagreements, unresolved points, missing dates |
| `sources` | Source records, preferably multiple where contested |

Source fields: `url` (actual HTTP(S) URL, no credentials), `publication_date` (ISO/null), `date_checked` (ISO), `quote` (verbatim excerpt or faithful data extraction), `anchor` (paragraph/page/table/row/search-result locator), `source_role` (primary/secondary), `evidence_type` (official_document/company_statement/news/dataset/other), `access_status` (opened/blocked/unchecked), `notes`. Optional `snapshot` = `{"path": "snapshots/C001-1.txt", "sha256": "...", "retrieved_at": "...", "method": "..."}`, produced by `scripts/save_snapshot.py` when the source is first read. The quote is then checked against the snapshot even offline or behind a proxy. A missing, out-of-folder or altered snapshot is FAIL. A snapshot records what the writer saw; it is not independent proof, so high-risk claims still go to a person. Empty support or blocked access is UNVERIFIED. No source is UNVERIFIED. Schema/reference inconsistencies are FAIL. A legal/list conclusion lacking an opened primary official document or dataset escalates to UNVERIFIED; adding one does not prove its applicability.

Notes must capture issue-specific context: applicable law/version/jurisdiction/effective vs proposed state; list aliases/search terms/version/date; negative claim's bounded search scope; numbers' units/period/currency/denominator/computation; company response date and procedural status. These are reviewer obligations, not generic keyword truth rules. Use optional local retained public-source extracts if helpful and record their file/hash in notes; do not retain private data.

Wrap each atomic fact: `<span data-claim-id="C001">Exact claim text.</span>`. Use separate IDs for separate propositions. A repeated exact proposition may reuse an ID; nested IDs fail. Any wording change requires updating the ledger and re-review. Orphan claims escalate; unknown IDs/text mismatches fail. The code detects a few unmarked high-risk phrases; a human must check comprehensive coverage, including unstated premises and tables.

## Independent review v1

Do not create real approvals on someone else's behalf. Templates and synthetic review fixtures only demonstrate the format. Store JSON:

```json
{
  "schema_version": 1,
  "reviewer": "reviewer-name",
  "actor": "human",
  "date_checked": "2030-01-02",
  "report_sha256": "sha256-of-exact-utf8-html-bytes",
  "ledger_sha256": "sha256-of-exact-ledger-file-bytes",
  "coverage": {"complete": false, "notes": "Unmarked factual premises still need review"},
  "claims": [{
    "claim_id": "C001",
    "disposition": "unverified",
    "source_url": "https://fixture.invalid/source",
    "support_quote": "",
    "anchor": "",
    "rationale": "Awaiting source-specific confirmation; not a real review"
  }],
  "signoff": {"reviewer": "reviewer-name", "date": "2030-01-02", "decision": "hold"}
}
```

Compute hashes with `python3 -c "import hashlib,pathlib; print(hashlib.sha256(pathlib.Path('report.html').read_bytes()).hexdigest())"` and repeat for the ledger. Save the review separately so its own edits do not alter the ledger hash. The validator records the current hashes in `review_report.json` too. It rejects stale reviews and same-author review. `actor` is human / independent_agent; the latter never completes human sign-off.

Supported review requires the exact ledger source URL, excerpt and anchor plus a specific rationale. Reviewers must independently confirm those contents and their entailment. A source can be reachable and irrelevant. Unsupported → FAIL; unresolved/missing review → UNVERIFIED. A human's approve record is only a recorded assertion, not an authenticated digital signature. Rejection is FAIL; hold remains UNVERIFIED. No keyword rule can independently decide all legal truth or detect a maliciously fabricated review. Author labels never authorize PASS. An approved record cannot erase other FAIL/UNVERIFIED findings.

## Security/date validation extension (v1 compatible)

Public source URL eligibility and cross-field temporal relationships are now checked. See [security-and-dates.md](security-and-dates.md). Add `timezone`, `cutoff`, `generated_at` when documented. Source publication/check dates and review/signoff dates accept ISO date or timestamp with precision/offset; null unknown observations are UNVERIFIED. Source `recheck_reason` documents a later historical check, never excuses a future completed check. Event dates remain future-compatible. Missing cutoff is UNVERIFIED and a partial HTML date does not manufacture a year.

`--as-of` is fixture-only, printed in QA, and keeps every chronological check enabled. Real ledgers use actual runtime. Impossible source dates prevent a recorded support PASS; adding a source or an approval cannot erase temporal failures. URL existence and date plausibility still do not prove source support.
