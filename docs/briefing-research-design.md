# Briefing workflow: research design notes

Proposals for after the reliability work. None of this is implemented. Each item says what it would change, how it
would be judged, and what it depends on. The workflow's structure (Chief → Leads → Scouts, an independent reviewer,
human sign-off) stays as it is.

## 1. Adaptive allocation

The budget policy (`src/server/briefing-budget.ts`) is fixed: equal caps per role, a fixed reserve, a fixed wrap-up
threshold. In the offline simulation (`scripts/briefing-budget-sim.ts`, simulated spending, not real usage), it
always leaves room for the review and a second review. The cost is about two fewer scouts per run than the earlier
90 % gate.

- **What:** let leads ask for scouts by expected value: open questions per category, carried-over cases, candidate
  leads from discovery. Size each scout's cap from the topic (a list update is cheaper than a new rule). Release the
  rework reserve back to research once a review passes without findings.
- **Constraint:** the reserve guarantee stays a hard rule. Adaptation only moves budget between research tasks.
- **Judged by:** report coverage (events found that a reference run found), not tokens alone.
- **Depends on:** recorded per-task outcomes (claims accepted per 100k tokens, by category) from several live runs.

## 2. Persistent temporal evidence

Each run starts from the active-cases file and re-finds what earlier runs already established.

- **What:** a store of accepted claims across runs, keyed by source SHA-256. Each claim carries its coverage window,
  its cutoff and the run that accepted it. A new run may cite an earlier claim as *carried over*: its date stays the
  earlier one, it is labelled as such, and it never counts as new evidence in the window.
- **Constraint:** the dates stay apart (`references/security-and-dates.md`, "Six dates, kept apart"). A carried-over
  claim cannot make a later event `confirmed`.
- **Judged by:** fewer refetches of unchanged sources, and no claim whose date falls outside the window shown as new.
- **Depends on:** a retention and deletion rule for stored source texts.

## 3. Active verification

The reviewer reads what is there. It does not go looking for the strongest counter-evidence.

- **What:** for high-risk claims (legal state, export-control lists, figures), the reviewer gets one bounded check
  task: find the primary document or a contradicting report. It runs under the reviewer's own budget and sandbox,
  with network access limited to fetching. Its result is a finding with evidence, never an edit.
- **Constraint:** no new agent role. This is a bounded tool for the existing reviewer, inside the review reserve.
- **Judged by:** seeded-error recall (planted wrong legal states, wrong dates) on fixture runs, and the
  false-finding rate.

## 4. Fair comparison

The multi-agent workflow should be compared with simpler setups on equal terms before anyone claims it is better.

| Arm | Setup |
|---|---|
| A | Single agent with the Skill (the existing workflow) |
| B | Codex native subagents, same Skill, same budget |
| C | Kanna Delegator, same Skill, same budget |
| D | This workflow |

- **Same inputs:** window, cutoff, discovery candidates, model, effort and fresh-token budget. The same fixed set of
  weeks. The source pages are frozen to snapshots, so live web changes do not decide the result.
- **Measures:**
  - recall of a reference event list built by a person before the runs;
  - claims supported by their quote;
  - seeded errors caught;
  - status-label accuracy (official vs reported vs proposed);
  - human review time;
  - fresh tokens and wall time.
- **Blinding:** reviewers score reports without knowing the arm.
- **Rule:** report every arm and every week, including losses. Do not tune prompts on the evaluation weeks.

## 5. Ablations

Each ablation removes one mechanism from arm D, on the same weeks.

| Removed | Expected effect if the mechanism matters |
|---|---|
| Independent reviewer | More seeded errors and label errors reach the report |
| Budget reserve (back to the 90 % gate) | Runs that end without a review or second review; more research |
| Claim-level labels | Media-only claims shown as official in mixed stories |
| Provenance and lost-claim checks | Silent claim drops between draft versions |
| Wrap-up notices | Agents stopped at their cap before handing in; lost partial work |
| Scouts (leads research alone) | Lower recall, lower cost |

## Order

Items 4 and 5 come first. They need no new mechanism, and they tell us whether items 1–3 are worth building.
