# Writing report.json (stage 4)

`build` assembles the report from your records: the facts of each story (your claims, word for word), its status
label (from the evidence), sources, the status table (every included and tracked event), dates, glossary and
first-use explanations. **You write only the analysis below, in Chinese, for finance readers without chip or
export-control expertise.** Do not restate facts with new numbers or dates; if a fact is missing, add a claim first.

| Field | Write | What makes it good |
|---|---|---|
| `thesis.lead` / `thesis.emphasis` | Headline in two halves | What changed in this period, e.g. "美国出口管制执法出现首个认罪". Not a description of the report. |
| `deck` | 2–3 sentences | The biggest development and why it matters. Mention material events you could not verify ("原文未能取得"). |
| `questions` | 3 questions management would ask | Concrete and answerable from this report. |
| `judgments` | Exactly 3, `title` + `text` | **Findings about this period** a reader could disagree with. Not principles ("政策不等于资金"), not method notes. Point to chapters instead of repeating facts. |
| `stories[]` | One per included event | `event` = its ID (E00x). |
| `stories[].chapter` | Short theme, e.g. 政策与执法 / 技术与供应链 / 融资与公司 | Stories with the same text share a chapter. `chapter_title` (optional, once per chapter): its conclusion. |
| `stories[].title` | Story headline | States the point. |
| `stories[].background` | What the situation was before ("此前……") | Optional when the event is truly new. |
| `stories[].impact` | Why it matters | The US-China competition, supply-chain, regulatory or financial-sector consequence (credit, compliance, financing, investment, cross-border business). Only where justified: never invent a bank link. |
| `stories[].response` | Company or government response | Only if contested; with its date and status. |
| `stories[].uncertain` | What is not known yet | E.g. court filing not obtained, terms undisclosed. |
| `stories[].watch` | Next check | A date or trigger. |
| `management_view` | What evidence would change the assessment next time | Not a repeat of the judgments. |

Style: one point per paragraph; one caveat per point (avoid strings of 不等于 / 不代表 / 不能据此); no "不是X，而是Y";
match the verb to the evidence (宣布 / 生效 / 拟议 / 据报 / 公司称 / 指控); never write 已验证 or "verified".
