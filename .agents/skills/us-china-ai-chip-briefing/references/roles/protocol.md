# Multi-agent protocol (every role)

You are one agent in a hierarchical briefing run managed by Nex: Chief Editor → US Lead and China Lead → Topic
Scouts, plus an Independent Reviewer. Nex tracks every task, its inputs, outputs and dependencies. Your message lists
your task ID, your task directory (TASK) and the skill directory (SKILL).

## Records, not messages

- Your result is what you **submit**, not what you say. Call `briefing_submit` when your records are ready. Nex runs
  `scripts/check_handoff.py` on them; if it refuses, fix what it lists and submit again. A turn that ends without an
  accepted submission is recorded as a failed task.
- Write only inside TASK. Never edit another task's directory, `workflow.json` or files Nex wrote
  (`assignment.json`, `submission.json`). Other agents' records reach you through Nex merges.
- Keep facts in the records: sources via `brief.py fetch`, events via `brief.py event`, claims via
  `brief.py add-claim` (the quote must be found in the saved page). Never edit the JSON records by hand; to correct
  a claim, `brief.py withdraw` it with a reason and add the corrected one. Run commands from SKILL:
  `python3 scripts/brief.py <command> TASK …`. The run is already initialised in English (`--lang en`).
- Claim text is English, written exactly as it will appear in the report: explain each abbreviation or product code
  inside the claim at first use ("the US Department of Justice (DOJ)"). Quotes stay verbatim in the page's own
  language (Chinese sources are quoted in Chinese). News-only facts are attributed: "According to Reuters, …".
  `--kind` takes only `factual`, `technical`, `legal`, `list`, `negative`, `statistic` or `company_response`.
- Decide every event (`include` / `track` / `exclude`) with a one-line reason. For include and track also give
  `--materiality` and the three selection answers: `--link "…" --size "…" --new "…"`. A material event you could not
  source is `track`, never dropped. A tracked event's title and reason are printed in the report's status table, so
  write them for the reader, without record IDs (E013, C004) or working notes; name duplicates only in exclude reasons.
- Mark proposed, pending or not-yet-effective measures with `--proposed`. Never describe a proposal as enacted, a
  report as confirmed, or an allegation as fact.

## Narrative

`TASK/narrative.md` (scouts, leads, cross-border replies) is a readable English analysis: what happened, why it
matters for US-China AI and semiconductor competition, how the developments relate, what is still uncertain and what
to watch next. Cite events by ID (`E003`) and claims by ID (`C007`) wherever a statement rests on them; every
included event must be discussed. Separate fact (cite a claim), reported claim (attributed) and your analysis
("This suggests …"). Do not restate figures or dates that are not in a claim. Do not force links between unrelated
events; a standalone story can stay standalone.

## Output envelope

`TASK/output.json`, written by you:

```json
{"task_id": "<your task id>", "status": "complete", "summary": "2–4 sentences",
 "source_issues": [{"url": "https://…", "problem": "HTTP 403; paywall"}], "open_questions": ["…"]}
```

`status` is `partial` when you could not cover part of the assignment; then add `"partial_reason"`. Leads add
`"gaps"` and `"cross_border_requests"` (see the lead instructions).

## Budgets

Nex enforces time and task budgets. Stop searching when new queries only return events you already have. A partial
submission with honest gaps is better than a timeout, which is recorded as a failure.
