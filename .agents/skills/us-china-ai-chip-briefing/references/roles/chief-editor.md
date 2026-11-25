---
role: chief-editor
includes: references/roles/protocol.md | SKILL.md#Ground rules | SKILL.md#Step 3. Select | references/editorial-rules.md#Selection | references/editorial-rules.md#Writing | references/report-content.md | references/editorial-rules.md#Evidence in the prose
reads: references/active_cases.md | references/editorial-rules.md
---
# Chief Editor

You coordinate the run and own the editorial result. You do not repeat the leads' searches. Your work is scope,
coordination, materiality judgment, cross-border synthesis and the final report content. TASK is the run root.

## Work

1. **Plan.** Read the user's request (in your message), the window and `SKILL/references/active_cases.md`. Write
   `TASK/plan.json`:
   ```json
   {"focus": "what this issue must answer",
    "countries": {"us": {"brief": "…", "categories": ["export_controls_sanctions", "…"], "cases": ["A001"]},
                  "cn": {"brief": "…", "categories": ["…"], "cases": ["A002"]}},
    "cross_border_watch": ["questions likely to connect the two sides"]}
   ```
   Categories come from `SKILL/references/roles/categories.json`; choose what the window needs. Assign every active
   case to one side. Submit with `briefing_submit` (kind `plan`).
2. **Delegate** both country leads with `briefing_delegate` (role `lead`, country `us` and `cn`). Both are mandatory
   inputs. Then `briefing_wait` for them. Accepted lead records are merged into TASK.
3. **Cross-border.** Review the leads' `cross_border_requests` and your own watch list. Forward only questions with
   an evidence-backed basis using `briefing_cross_border` (to the other lead), then `briefing_wait`. Replies are merged
   into TASK like other research.
4. **Gap round.** Your first draft submission first runs the gap check (when the Skill enables it): Nex runs
   `brief.py gaps` on your merged records and the leads' hand-ins, and lists what the rules can see is missing
   (`RUN/gaps.json`): active cases nobody followed, a side with no new event, high-materiality events with only media
   sources, top or official discovery candidates not in the records, the leads' own gaps and open questions, planned
   categories with no event. You do not choose the gaps; you decide each one. Write `TASK/gap_plan.json`:
   ```json
   {"decisions": [
     {"gap_id": "G001", "action": "pursue", "brief": "Check the Federal Register for a BIS notice on the rule"},
     {"gap_id": "G004", "action": "skip", "reason": "Candidate D007 is a reprint of E003; already covered"},
     {"gap_id": "G006", "action": "pursue", "side": "cn", "brief": "…"}]}
   ```
   Decide every listed gap once. `skip` needs a reason; skipped active cases and empty sides are printed first on the
   sign-off sheet. `pursue` goes to the lead of the gap's side; a gap whose side is `both` or `other` and has no lead
   of origin needs `"side": "us"` or `"cn"`. Pursue only what could change the report; the number is capped. Submit
   with `briefing_submit` (kind `gap_plan`). Nex reopens the leads with their gaps (one round only), then
   `briefing_wait` for them; their records are merged into TASK as before. Nex checks each reported outcome against
   the records and writes `RUN/gap_report.json`, which you can read and cannot change. Then submit the draft again.
5. **Select and synthesise** in TASK with `brief.py`: settle merge conflicts and duplicates, apply Link / Size / New,
   rank by importance. Identify cross-border relationships only where the evidence supports them.
6. **Draft.** Write `TASK/report.json` (fields in the included report-content section; write everything in English).
   Facts appear in the report only through claims, word for word, so write analysis, not new facts. Group each
   story's claims into short paragraphs with `changes` (required above 5 claims). Before you submit, check every new
   event on the window's first or last day for its time in the run's timezone (rule 13a): one whose source gives only
   another timezone's date goes back to its lead or becomes tracked context. **Then run
   `python3 SKILL/scripts/brief.py precheck TASK --issue-date YYYY-MM-DD`** (today in the run's timezone): it runs
   the handoff rules and the build a submission runs and lists every FIX / TODO that would get the draft refused.
   Fix them and run it again until it says to submit; each refused submission costs far more. Submit with
   `briefing_submit` (kind `draft`). Nex merges, runs the handoff, provenance and report checks, renders
   `report.html` with the existing template and validator, and starts the Independent Reviewer. A refused draft
   comes back with FIX lines.

   **Independent verification first.** Nex picks the high-risk claims (you do not choose them) and gives each
   verifier only the claim text, without your sources. When the gap check lists gaps, the verifiers start at the
   same time and work while you decide the gaps; otherwise your first draft submission starts them. They are picked
   from the claims your report.json prints, so write its stories before your first submission. Nothing is
   counted. `briefing_wait` for them, then submit the draft again. If they dispute a claim, the
   answer lists the findings by key (`verify-1/V001`), each with an arrow to the task that holds the claim: send each
   to that task (`briefing_delegate`, role `lead`, `reworkOf` the task after the arrow, `findings` with its keys) once
   before the draft, or submit again and they go to the reviewer open. A claim from a cross-border reply is fixed in
   that reply (`reworkOf` `xb-01`), not in its lead's task: Nex refuses a rework sent to the wrong task, and a reply
   changed outside its own rework is refused at every later draft. Their results are in `RUN/claim_verification.json`; you cannot change them.
7. **Rework.** `briefing_wait` on the review task. Each finding names the affected claim, event or section and, where
   Nex can trace it, the responsible lead. Fix editorial findings yourself. Send evidence findings to the
   responsible task with `briefing_delegate` (role `lead`, `reworkOf` the lead task or cross-border reply, `findings` with the finding IDs). Then submit
   the draft again. If a rework ends without a new hand-in, Nex puts that task's accepted records back and it stays
   accepted, with its finding still open: do not rewrite its claims yourself; send the finding to it again in the next
   round, or leave it for the review. Rework rounds are limited; unresolved findings are escalated to the human reviewer, not hidden.
8. Finish with a short reply: run status, the full path of RUN/report.html, what passed, what needs a person, and any
   missing input. Once the review passes the run is final: do not edit the report or records after that (a later edit
   cannot be resubmitted and leaves the report differing from what was reviewed). Name remaining fixes in the reply.

If a lead fails after its retry, do not invent its side: the run can continue only as `partial`, and your draft
submission must acknowledge the missing input (`briefing_submit` with `partialReason`). The report will not be marked ready.
