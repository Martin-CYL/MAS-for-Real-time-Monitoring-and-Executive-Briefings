# Active case follow-ups

Each case is a **question to recheck**, not a fact to reuse. The "Last known (unverified carry-over)" column says what the previous issue believed, so the next run knows what to look for. Before any of it appears in a report, reopen a source, record it in the ledger, and update this table.

Every issue must add one entry per case to `coverage.json` with the matching `case_id` and a decision (included / background / excluded with reason). `validate.py` warns when a case has no entry. Close a case when its closure condition is met; add new cases when a story will need follow-up.

| Case ID | Question | Last known (unverified carry-over, from 2026-10-09 issue) | Next check | Closure condition |
|---|---|---|---|---|
| A001 | Has BIS formally extended, changed or reinstated the Affiliates Rule (50% ownership rule)? | Suspension runs to 2026-11-09 and reimposes 2026-11-10 unless BIS publishes an extension; truce extension announced but no Federal Register notice seen | Federal Register before 2026-11-09 | Federal Register notice published, or rule in force |
| A002 | Has China extended or reinstated the suspended October 2025 rare-earth export measures? | Suspension to 2026-11-10 | MOFCOM announcements before 2026-11-10 | MOFCOM announcement |
| A003 | Status of the US-China trade truce and next leader meetings | Extension to 2027-01-10 announced by US Treasury Secretary on 2026-09-23; APEC Shenzhen and AI dialogue expected November 2026 | Each issue; APEC week | Formal agreement, breakdown, or 2027-01-10 passes |
| A004 | Has the US-China AI incident communication channel been set up? | Agreed after the 2026-09 Washington summit; no details published | Each issue | Channel described or first use reported |
| A005 | Outcome of the FCC vote on restricting Chinese test labs | Vote scheduled 2026-10-29 | 2026-10-29 | Vote result and final rule text |
| A006 | Has China approved Nvidia RTX Pro 5500 purchases, and have deliveries started? | Media report 2026-09-27 that MIIT intends to approve; earlier reported stop order on RTX Pro 6000D (2025-09) | Each issue | Confirmed approval or orders/deliveries, or denial |
| A007 | 1260H list changes and company litigation (Alibaba, Tencent, WuXi AppTec) | Alibaba sued DoD 2026-06-23; WuXi sued 2026-06-11; Tencent listed since 2025-01 | Each issue; court dockets | Court ruling, removal, or new list version |
| A008 | NS-CMIC status of named companies (date-stamped search) | Earlier check found no listing for Alibaba or Tencent by name | Each issue a named company appears | n/a (recurring check) |
| A009 | DOJ GPU server diversion case (> US$300m) | Charges announced 2026-10-01; no conviction | Monthly | Plea, verdict or dismissal |
| A010 | TSMC results and advanced-packaging capacity | Q3 results due 2026-10-15 | 2026-10-15 and monthly revenue around the 10th | Recurring; close when no longer material |
| A011 | Huawei–Qualcomm patent purchase approval | Approval pending | Each issue | Approval, rejection or closing |
| A012 | Tencent proposed offshore bond | Media report 2026-10-08, up to US$5bn | Each issue | Pricing announcement or report denied |
