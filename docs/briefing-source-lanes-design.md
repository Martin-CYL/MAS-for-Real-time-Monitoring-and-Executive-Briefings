# 设计方案：按信息来源分工的搜索员（Source Lanes）

状态：已实现，未做真实运行，也还没做第 9 节的评估。Nex 在 `feature/briefing-source-lanes`（基于
`feature/briefing-claim-verification`），Skill 在 `skill/briefing-source-lanes`（基于 `skill/briefing-claim-verification`）。
默认仍是按题目分（`scout_mode: "topic"`），在 Skill 的 `workflow.json` 里改成 `"lane"` 才启用。
现行行为以 [briefing-workflow.md](briefing-workflow.md) 的 "Source lanes" 一节为准。和独立核验员可以分开开关。

实现与本方案的不同之处：

- **线名从哪来**：`check_handoff.py` 默认从 `assignment.json` 的 `lane` 读线名，控制器同时传 `--lane`；
  两者不一致时不通过（`LANE_MISMATCH`）。Scout 自己运行检查时结果和提交时一致。
- **企业线的检查**：只检查类型（只能记 `company_statement` / `dataset`）。"把官方网站上的政府文件记成公司声明"
  没法机械判断（EDGAR 和交易所网站本身就在官方名单里），所以没做这一条。
- **线索怎么并到同一事件**：控制器根据 Lead 目录里的 `merge_log.json`，把媒体线 Scout 的事件编号换成 Lead 自己的
  事件编号，并给每条线索编号 `L001…`。跟进的 Scout 拿到该事件的标题、日期和哪一方，必须用完全相同的值记录事件，
  这样现有的合并规则（标题几乎相同、同一方、三天内）就会把两边并成一件事。交接检查用 `lead_results` 核对：
  每条线索都要有 `found` 或 `not_found`；`found` 的事件必须标题、日期、哪一方一致，并且有一手来源的说法。
- **未处理线索的提醒**：由控制器在 Lead 交接时给出（`PRIMARY_LEAD_UNHANDLED`，跟着交接结果到主编），
  不在 `check_handoff.py` 里，因为只有控制器知道哪些线索已经派出跟进。在 `gaps` 里写明线索编号就不再提醒。
- **每条线的上限**：放在 `workflow.json` 的 `token_budget.lane_fresh_tokens`。没有重跑预算模拟：
  调低单个上限只会减少正在运行的 Scout 占用的额度，审稿、二审和核验的预留保证不受影响。
- **按线统计**："被别的线印证的事件"按 Lead 记录里来源（provenance）跨两条线以上的事件计数。

## 1. 要解决什么

现在每位 Lead 按**题目**派 Scout（`references/roles/categories.json` 里的 6 个类别）。每个 Scout 什么都干：
官方原文、公司公告、新闻都自己搜（`references/roles/topic-scout.md` 第 2 步）。几个 Scout 是同一套做法跑几遍，
只是题目不同。

带来三个问题：

- **来源类型靠自己填。** `brief.py add-claim --type` 会覆盖按网址自动判断的类型（`evidence_tools.add_claim`），
  报告的"官方确认"又是按这个类型算的（`brief.py evidence_status`，`PRIMARY` 集合）。`source_domains.json`
  目前只用来提示"可能标错了"，不拦。
- **没有分工上的协作。** 媒体报道里提到的原始文件，要等同一个 Scout 自己想起来去找。11-06 实测里，
  两位 Lead 各只派了 1 个 Scout，中美之间互相求证 0 次。
- **分歧出不来。** 一件事只被一个 Scout 记录，"官方说拟议、媒体说已生效"这种分歧在合并时根本不会出现。
  11-06 的稀土和六个公告的问题都属于这一类。

## 2. 一句话设计

每位 Lead 下面的 Scout 不再按题目分，而是按**信息来源**分成三条线：官方原文、企业披露、媒体。每条线只能记录
自己那一类来源，并由交接检查强制执行。媒体线必须交出"该去找哪份原文"的线索，由 Lead 在第二轮交给官方线去找。
几条线各自找到的同一件事，在合并时自然形成互相印证或冲突。

不改变 Chief → Lead → Scout 的结构，也不增加新的角色层级。题目不取消，变成每条线里要覆盖的类别清单。

## 3. 三条线

| 线 | 去哪里找 | 能记录的类型 | 主要任务 |
|---|---|---|---|
| `official` 官方原文 | 美：联邦公报 API、BIS、Commerce、Treasury/OFAC、USTR、白宫、DOJ、FCC、国会。中：商务部及安全与管制局、工信部、国务院、网信办、发改委、海关、市场监管总局、证监会；新华社、人民网对部委文件的转载 | `official_document`、`dataset` | 逐个过一遍官方渠道（`sources.md` 第 3 节），只认原文；一个空的列表页不能当作"没有新规"的证据 |
| `company` 企业披露 | 公司投资者关系页和新闻页、SEC EDGAR（8-K、10-Q）、港交所披露易、上交所、深交所、巨潮资讯网 | `company_statement`、`dataset` | 公司公告、财报里的中国风险和许可证影响、上市和融资 |
| `media` 媒体 | 通讯社和财经媒体、大中华区媒体、行业和科技媒体（`sources.md` 第 5 节） | `news`、`other` | 找得广；每条说法注明"据某某报道"（现有规则）；给出原始文件线索（第 5 节） |

中文来源不单独设一条线：中国线 Lead 下的三条线本来就以中文来源为主。第三国的事（ASML、台积电、日本和荷兰的规定）
按现有规则归影响到的那一方，再按来源归到对应的线。

每条线内部仍然按 `categories.json` 覆盖类别。Lead 在派任务时给出这条线这次要重点覆盖的类别、要复查的
持续跟踪事项（active cases）和发现阶段的线索。

## 4. 来源类型怎么强制

靠交接检查，不靠提示词。`check_handoff.py` 增加 `--lane official|company|media`，控制器在 Scout 提交时传入：

| 线 | FAIL 条件 |
|---|---|
| `official` | 说法的 `evidence_type` 不是 `official_document` / `dataset`；或者标为 `official_document` 的来源网址不在 `source_domains.json` 的官方名单里 |
| `company` | `evidence_type` 不是 `company_statement` / `dataset`；或者把官方网站上的政府文件记成公司声明。EDGAR 和交易所网站在官方名单里，但上面的公司文件要记 `company_statement`，这是允许的 |
| `media` | 记录了 `official_document` 或 `company_statement`。媒体线看到原文也不自己记，而是写进线索交给官方线 |

`add-claim` 本身不改：单智能体模式和按题目分的模式照旧可以用 `--type` 覆盖。

**限制**：系统层面不能按域名限制联网（`briefing-workflow.md` 的 "Agent permissions" 一节），官方线 Scout
仍然打得开路透社。只有被记录的说法才能进报告，所以在交接时检查已经足够，不需要限制网络。

## 5. 线索交接：媒体线 → 官方线

媒体线的 `output.json` 增加一项：

```json
{"primary_leads": [
  {"event_id": "E004",
   "agency": "BIS",
   "document_hint": "实体清单新增条目的联邦公报规则",
   "url_hint": "https://www.federalregister.gov/...",
   "why": "路透社称已生效；只有媒体来源，状态待原文确认"}]}
```

- `event_id` 必须是这个 Scout 自己记录过的事件，`agency` 和 `document_hint` 必填，`url_hint` 可选。
- 控制器在 `briefing_wait` 的返回里，把同一国家下所有媒体线的线索合并成一张表交给 Lead。

Lead 的工作分两轮：

```
第一轮：official、company、media 三条线同时派出
     → briefing_wait，合并记录
第二轮：Lead 看线索表和覆盖缺口
     → 用剩下的名额派一个 official 线 Scout，assignment 里带上 primary_leads
     → 找到原文：用 add-claim 记录官方说法，合并时并入同一事件，事件升级为有官方来源支持
     → 找不到：事件保持"据报道"，Lead 在 gaps 里写明查了什么
```

第二轮可以不派：线索为空，或者 Lead 判断这些事都不够重要。这时必须在 `gaps` 里写明没跟进的线索和原因，
交接检查对未处理的线索给 WARN。

## 6. 互相印证和冲突

不需要新机制。`merge_runs.py` 已经会合并重复事件（同一跟踪事项、同一网址，或者同一方三天内标题几乎相同），
保留更谨慎的 `proposed` / `unsupported` / 重要性取值，其余分歧记进 `merge_conflicts`，由 Lead 用
`brief.py event decide` 处理。

按来源分工以后，同一件事会被不同的线分别记录，这一步就有了实际作用：

- 官方线和媒体线各自找到同一件事 → 一个事件同时挂着官方说法和媒体说法，这正是 `labels_for` 的"混合证据"情况；
- 两边对状态的说法不一致 → 出现在 `merge_conflicts`，Lead 必须裁决。以前一个 Scout 一个人说了算，不会出现。

运行摘要（`qa/workflow_summary.md`）增加按线的统计：每条线记录的事件数和说法数、被别的线印证的事件数、
冲突数、线索数和找到原文的数。

## 7. 数量、并发和预算

| 项目 | 现在 | 本方案 |
|---|---|---|
| 每位 Lead 的 Scout 数 | 最多 4（`max_scouts_per_lead`） | 3 条线 + 1 个第二轮，仍是 4 |
| 全程同时运行的 Scout | 4（两国合计，`max_concurrent_scouts`） | 不变；第一轮 6 个，排队的按空位启动 |
| 同时存活的会话 | 主编 1 + Lead 2 + Scout 4 = 7 | 不变，低于 Nex 上限 8（`MAX_LIVE_CHATS`） |
| 每个 Scout 的 token 上限 | 25 万 | 按线设：`official` 15 万、`company` 10 万、`media` 15 万（建议值，待模拟） |

11-06 实测每个 Scout 只用了 2–4 万新 token，上限远没有用满，所以调低单个上限不会限制正常工作，反而能让
预算算法（`briefing-budget.ts`）在同样的预留下多放几个 Scout 同时启动。改动前用 `scripts/briefing-budget-sim.ts`
重新模拟，确认审稿、二审和核验的预留仍然有保证。

预计的代价：总耗时变长（第一轮要排队，还多一轮）；Lead 合并时要处理的重复和冲突变多。这两项都要在评估里记录。

## 8. 和独立核验员的关系

两者分工不同，不冲突：

- 官方线 Scout 仍然是"作者"。核验员照样不看作者的来源和笔记，独立去找原文（`verifier.md`）。
- 来源分工让交给核验员的说法标签更干净，预期被推翻的会更少；被推翻时也更容易按出处退回给对应的线。
- 核验员挑哪些说法、怎么比对，都不变。

## 9. 怎么评估

在 [briefing-research-design.md](briefing-research-design.md) 第 4、5 节的框架里做，规则相同：同一批固定的
时间窗口，冻结网页快照，同样的模型和总预算，不在评估样本上调提示词，每一组每一周的结果都报告。

| 组 | 设置 |
|---|---|
| D | 现有多智能体流程，按题目分（`scout_mode: "topic"`） |
| D-lanes | 同样的流程，按来源分（`scout_mode: "lane"`） |
| D-lanes − 交接 | 按来源分，但不派第二轮（检验线索交接本身有没有用） |

看这些数：

- **主要看**：
  - 报告里"官方 / 媒体 / 拟议 / 未核实"标签的准确率（人工事先标好）；
  - 第一轮只有媒体来源的事件里，第二轮找到官方原文的比例；
- **其次看**：
  - 对照人工事件清单的召回率；
  - 埋入错误（把媒体说法当官方、把拟议写成已生效）被抓出的比例；
  - 新 token、总耗时；
  - Lead 处理的重复数和冲突数。

判断标准写在前面：D-lanes 的标签准确率明显高于 D，召回率不下降，成本增加在 30% 以内，才默认改为按来源分；
否则保留为可选模式。如果 D-lanes − 交接 和 D-lanes 差不多，说明第二轮没用，可以去掉。

## 10. 要改哪些地方

**Skill**（预计约 1 周）

- 新增 `references/roles/lanes.json`：每条线的 id、名称、允许的 `evidence_type`、要过的渠道（引用 `sources.md`
  的小节）、建议预算。和 `categories.json` 一样是配置，不写死在代码里。
- `references/roles/topic-scout.md`：拆出三条线的工作说明。可以改成 `source-scout.md` 按线分节，
  也可以每条线一个文件；`topic-scout.md` 保留给按题目分的模式。
- `references/roles/country-lead.md`：默认先派三条线；第二轮处理线索表和覆盖缺口；`gaps` 里写明没跟进的线索。
- `scripts/check_handoff.py`：`--lane` 的检查（第 4 节）；`primary_leads` 的格式和"事件必须是自己记录的"检查；
  Lead 交接时对未处理线索给 WARN。
- `references/roles/workflow.json`：`scout_mode: "topic" | "lane"`（默认 `topic`，先不改变现有行为）、
  每条线的 token 上限。
- 回归测试：官方线记了媒体来源被拒；媒体线记了官方类型被拒；EDGAR 上的公司文件在企业线通过；
  按题目分的模式不受影响。

**Nex**（预计约 1 周）

- `src/server/nex-briefing-tools.ts`：`briefing_delegate` 加 `lane` 参数，以及第二轮用的 `primaryLeads`。
- `src/server/briefing-contracts.ts`：Scout 的 `output.json` 允许 `primary_leads`。
- `src/server/briefing-workflow.ts`：
  - 派任务时按 `lanes.json` 校验线名，`scout_mode` 为 `lane` 时必须给 `lane`；
  - 判断"同一个任务是否重复派了"的键从题目改为"题目 + 线"；
  - Scout 标题和 `assignment.json` 带上线名和允许的类型；
  - 提交时把 `--lane` 传给 `check_handoff.py`；
  - `briefing_wait` 返回合并后的线索表；
  - 按线的 token 上限；运行摘要的按线统计（第 6 节）。
- `src/server/briefing-budget.ts`：按线的上限；重跑预算模拟。
- 测试（`briefing-workflow.test.ts`，脚本化）：
  - 三条线并发和排队；
  - 线索从媒体线传到第二轮官方线；
  - 线名不对被拒；
  - 重复派同一条线时返回已有任务；
  - 重启后线名和线索不丢；
  - 按题目分的模式不变。
  `briefing-workflow.skill.test.ts` 用真实 Skill 脚本覆盖一次完整的两轮。

**评估**（约 1 周，加人工标注时间）：第 9 节，可以和核验员的评估共用同一批样本和人工事件清单。

## 11. 不做的事

- 不按域名限制 Scout 的网络访问（第 4 节）。
- 不增加角色层级，也不让 Scout 之间直接通信；线索只经过 Lead。
- 不把"多条线都找到"当作"已确认"：两条媒体报道仍然只是媒体佐证，状态只由官方原文或核验员决定。
- 不取消按题目分的模式，它作为对照组和回退选项保留。

## 12. 待定的问题

1. 企业线是否值得单独占一个名额？如果窗口里公司公告很少，可以并进媒体线，把名额留给第二轮。要看实际运行里
   `company_statement` 说法的占比。
2. 第二轮是否改成控制器自动派（媒体线索不为空就派），而不是由 Lead 决定？自动派更可靠，但可能在不重要的线索上
   浪费预算。
3. 对小语种和第三国来源（日、韩、荷兰），官方名单要补哪些网址？现在的 `official_suffixes` 已经覆盖了
   `.go.jp`、`.go.kr` 等，荷兰政府网站 `.nl` 不在里面。
4. 安静的周里官方线可能什么都没找到。是否允许 Lead 第一轮只派两条线，把官方线留到第二轮集中查线索？
