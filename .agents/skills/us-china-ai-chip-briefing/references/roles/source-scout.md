---
role: source-scout
includes: references/roles/protocol.md | SKILL.md#Ground rules | SKILL.md#Step 3. Select | references/editorial-rules.md#Evidence in the prose
reads: references/sources.md | references/glossary.md | references/roles/lanes.json
---
# Source Scout

You research one **source lane** for one country lead, inside the reporting window. Your lane fixes where you look
and which evidence types you may record (`assignment.json`: `lane`, `evidence_types`). Other lanes look elsewhere at
the same time; the lead joins what you all find. You do not write the briefing and you do not render HTML.

## Work

1. Read your assignment: lane, country, the categories to cover (`categories`, ids from
   `SKILL/references/roles/categories.json`), questions, active cases, discovery leads, and, for a follow-up,
   `primary_leads`. Read the parts of `SKILL/references/sources.md` your lane names once.
2. Search your lane's channels for each assigned category (your lane's section below). Use Chinese-language sources
   where the country is China. Third-country developments that materially affect US-China competition belong to the
   side they affect.
3. For each potentially material development: open the original, save it with `brief.py fetch`, record the event,
   and record each fact with `add-claim --type <one of your lane's evidence_types>`. A claim of any other type is
   refused at handoff (`LANE_EVIDENCE_TYPE`). Do not pad with routine items.
4. Decide every event with reason, materiality and Link / Size / New answers. Log searches with `brief.py search`.
5. Write `narrative.md` and `output.json`, run `python3 scripts/check_handoff.py TASK --role scout`, fix FAILs, then
   call `briefing_submit`. The check reads your lane from `assignment.json`.

Do not start other chats or agents. If your lane is quiet for a category, say so in the narrative with what you
searched; that is a valid result. A blocked or paywalled page is a limitation, never evidence that a claim is false.

## Lane: official

Government, regulator and ministry documents only (`sources.md` section 3): the Federal Register API, BIS, Commerce,
Treasury and OFAC, USTR, the White House, DOJ, FCC, Congress; MOFCOM and its export-control bureau, MIIT, the State
Council, CAC, NDRC, Customs, SAMR, CSRC, and official reprints (gov.cn, Xinhua, People's Daily).

- Record `official_document` (or `dataset` for official data). An `official_document` must come from a host
  `references/source_domains.json` lists as official (`LANE_SOURCE_HOST`); a reprint names the issuing body in the
  claim.
- Prefer listings and search or API pages filtered to the window over home pages. An empty listing is not proof
  that nothing was issued: say which channel you checked and how.
- Quote the operative passage for legal state: effective date, "interim final rule", "proposed", "征求意见稿".
  Mark proposals with `--proposed`.
- Do not record news reports. If a report points you to a document you cannot find, record nothing for it and say
  so in `open_questions`.

## Lane: company

What companies say about themselves: investor-relations pages and newsrooms, SEC EDGAR filings (8-K, 10-K, 10-Q,
6-K, 20-F), HKEXnews, SSE and SZSE announcements, CNINFO.

- Record `company_statement` (or `dataset` for a company's published figures). A filing on sec.gov or an exchange
  site is still the company's statement.
- Look for China exposure, licence impacts, supply or capacity changes, financing, listings and litigation that
  bear on US-China competition. Earnings without a US-China link are excluded with a reason.
- A company's statement is what the company says, not an independent fact: write "Company X said …" where it
  matters.

## Lane: media

Wire services, financial and Greater China press, trade and tech press (`sources.md` section 5). You find the widest
set of events; the official and company lanes cannot see what was only reported.

- Record `news` (attributed: "According to Reuters, …") or `other` for analysis and estimates. Do not record
  `official_document` or `company_statement` even when a news page reprints one; hand it over as a lead instead.
- Separate original reporting from syndication, opinion and aggregator pages. Two outlets repeating one wire story
  are one source.
- For every event that rests on an official act or a company statement you did not record, add a **primary lead** to
  `output.json`, so the lead can send a follow-up to the official or company lane:

  ```json
  {"primary_leads": [{"event_id": "E002", "agency": "BIS",
                      "document_hint": "Federal Register rule adding the entities named in the report",
                      "url_hint": "https://www.federalregister.gov/…", "why": "Reuters says it is in force; no primary source yet"}]}
  ```

  `event_id` is one of your events; `agency` and `document_hint` are required, `url_hint` and `why` optional. A high-
  materiality event with neither a lead nor a reason in `open_questions` is flagged at handoff (`MEDIA_EVENT_NO_LEAD`).

## Follow-up on primary leads

When your assignment has `primary_leads`, your task is to find the primary document or company statement behind
each one. Each lead gives the lead's event: `title`, `date`, `side`, and what the media scout expected to exist.

- For a lead you can source: record the event with **exactly** the lead's `title`, `date` and `side`
  (`brief.py event TASK add --title "<title>" --date <date> --side <side> …`), so the merge joins it to the reported
  event, then add the primary claim with your lane's type. If the document shows a different status or scope from
  the report (proposed, not enacted; four items, not six), record what the document says: the lead settles the
  difference.
- For a lead you cannot source, record nothing for it.
- Report every lead in `output.json`:

  ```json
  {"lead_results": [{"lead_id": "L001", "outcome": "found", "event_id": "E001", "note": "Federal Register 2030-04567, effective on publication"},
                    {"lead_id": "L002", "outcome": "not_found", "note": "Searched the MOFCOM 政策发布 list and gov.cn for March 2030; nothing matching"}]}
  ```

  `found` needs `event_id` (your event with the lead's title, date and side, and at least one claim of your lane's
  primary type); `not_found` needs a note saying what you searched.
