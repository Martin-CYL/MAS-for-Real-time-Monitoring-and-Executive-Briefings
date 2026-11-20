# 设计方案：按缺口补搜一轮（Gap round）

状态：已实现，未做实测和样本评估（2026-11-20）。Nex 在 `feature/briefing-gap-round`，Skill 在 `skill/briefing-gap-round`，
分别基于独立核验的两个分支（`feature/briefing-claim-verification`、`skill/briefing-claim-verification`，
设计见 [briefing-verifier-design.md](briefing-verifier-design.md)）。实现和本文不同的地方见第 15 节；
运行方式见 [briefing-workflow.md](briefing-workflow.md) 的 Gap round 一节。是 [briefing-research-design.md](briefing-research-design.md)
第 1 项"自适应分配"的第一步。

## 1. 要解决什么

现在的计划是一次定死的：主编写完 `plan.json`、派出两位 Lead 之后，在写稿之前没有任何办法再派人。

- 每个国家只能有一位 Lead；再派会被拒绝（"already …"）。
- `reworkOf` 只在审稿之后、或核验提出异议之后才能用。
- 写稿前唯一能追加的是跨境请求。

所以"要不要补"全由 Lead 自己决定。2026-11-06 的测试运行里，两位 Lead 各只派了 1 个搜索员，主要的活自己干完就交了。
漏掉的东西要等到审稿人提 omission 才会被发现，那时已经在返工阶段，代价更高，而且审稿人只能看到候选池里有的东西。

## 2. 一句话设计

两位 Lead 交回结果、合并进主编目录之后，控制器按 Skill 里的规则**算出**覆盖缺口，交给主编决定补哪些；
主编每个缺口都要表态，不补要写理由。控制器带着缺口编号重开对应的 Lead，补一轮，然后**按规则核对**每个缺口是否真的补上。
之后才进入独立核验和写稿。

不改变 Chief → Lead → Scout 的结构。默认只补一轮。

## 3. 四条原则

1. **缺口由规则算，不靠感觉。** 和核验员挑说法（`brief.py verify-select`）是同一个思路：写的人不挑自己要补的题目。
   主编可以决定补哪几个，但不能让一个缺口无声消失。
2. **只补一轮，单独预算。** 不做"搜完再看、看完再搜"的循环。
3. **每个缺口都要有结局。** 补上了、搜过确实没有、或者没补（附理由）。"搜过确实没有"是有效结果，和"没去搜"分开记。
4. **补搜仍然经过 Lead。** 合并、去重、冲突处理和溯源检查都在 Lead 那一层，主编不直接派搜索员。

## 4. 在流程里的位置

```
计划 → 两条线研究（Lead + Scout）→ 合并到主编 → 跨境请求（已有）
     → 【新】缺口检查（gap_review）
         控制器运行 brief.py gaps → gaps.json
         主编写 gap_plan.json，briefing_submit（kind gap_plan）
         控制器按 gap_plan 重开对应的 Lead → Lead 补搜 → 交回 gap_results
         控制器核对 → gap_report.json
     → 说法核验（claim_verification，已有）
     → 主编写稿 → 校验器 → 独立审稿 → 返工 → 二审 → 人工签发
```

- **触发：** 和核验一样挂在主编的第一次初稿提交上。`submitDraft` 先过新的 `coverageGate`，再过已有的
  `verificationGate`。这次提交不计入初稿次数。
- **放在核验之前：** 核验要查的是最终说法，补搜进来的新说法也应该有机会被 `verify-select` 选中。
- **没有缺口：** `gaps.json` 为空，直接进入核验，什么都不花。
- **部分运行：** 某一边的 Lead 失败（只能以 `partial` 继续）时，那一边的缺口照样列出，但不能重开，结局记为 `not_reached`。

## 5. 缺口从哪来

由 Skill 的新命令 `brief.py gaps RUN` 计算，规则写在 Skill 里，不写死在 Nex 代码中。只收**能从现有记录算出来**的缺口：

| 类型 | 怎么判断 | 数据来源 | 默认优先级 | 建议的来源类型 |
|---|---|---|---|---|
| `case_unfollowed`：持续跟踪事项没交代 | 计划分给这一边的 A00x，合并后既没有带这个 `case_id` 的事件，也没有排除理由 | `plan.json`、`active_cases.md`、`events.json` 的 `case_id` | 5；"Next check"日期落在本期窗口内的为 6 | 多数是官方文件（Federal Register、MOFCOM） |
| `side_empty`：一边没有新事件 | `brief.py status` 已有的判断："no new China-side event" | `events.json` | 5 | 该边的官方和本国语言来源 |
| `single_source`：重要事件只有媒体来源 | `include` 或 `track` 的事件，重要性为 high，或者决定了状态标签，但没有一手来源（brief.py 的 `PRIMARY`：`official_document`、`company_statement`、`dataset`） | `evidence_ledger.json` 的 `evidence_type` | 4 | 官方文件或企业披露 |
| `discovery_unhandled`：发现阶段的线索没处理 | `discovery/events.json` 里排名前 10 的候选（`discovery_top`），或者来自官方来源的候选（D00x）；它的任何一条网址都不在 `sources.json` 里，也没有对应的 `exclude` 事件 | 发现扫描的输出 | 官方来源的候选为 4，其余为 3 | 看候选本身 |
| `declared`：Lead 自己报的缺口 | Lead `output.json` 里的 `gaps[]`、`open_questions`，以及失败后没有重试的搜索员 | Lead 的交接文件 | 3 | 原题目 |
| `category_empty`：计划了但没有事件的类别 | 计划给这一边的类别，没有一个事件归到它 | 需要事件带 `category`（见第 11 节） | 2 | 该类别 |

**不算缺口的：**

- "读起来有点薄"这类无法计算的判断，留给审稿人提 omission。
- 跨境问题，已有 `briefing_cross_border` 机制处理，这里不重复。
- 核验的 `not_found`，走核验自己的返工，不回到补搜（避免循环）。

`gaps.json` 每条记录：

```json
{"gaps": [
  {"gap_id": "G001", "type": "case_unfollowed", "side": "us", "priority": 6,
   "target": {"case_id": "A001"},
   "why": "A001 assigned to the US side; no event carries case A001 and no exclusion is recorded",
   "suggested_source": "official_document",
   "lead_task": "us-lead"}],
 "not_listed": 0}
```

最多列 20 条，按优先级排序，超出的数目写在 `not_listed`，并且会进运行摘要。

## 6. 主编怎么决定

主编在运行根目录写 `gap_plan.json`，然后 `briefing_submit`（kind `gap_plan`）：

```json
{"decisions": [
  {"gap_id": "G001", "action": "pursue", "brief": "Check the Federal Register for any BIS notice on the Affiliates Rule"},
  {"gap_id": "G004", "action": "skip", "reason": "Candidate D007 is a reprint of E003; already covered"}]}
```

控制器检查：

- `gaps.json` 里每条缺口都有一条决定，不能多，也不能少；
- `skip` 必须写理由。`case_unfollowed` 和 `side_empty` 两类被跳过时，理由会单独列在签发单最前面；
- `pursue` 最多 8 条（`max_gaps_pursued`）。

决定被接受后，控制器**自己**按缺口所属的一边重开 Lead，不需要主编再调用 `briefing_delegate`。主编接着
`briefing_wait`，等结果。这样少一次模型调用，也不会出现"决定要补、最后忘了派"的情况。

## 7. Lead 怎么补

重开的做法照现有的返工（`reopenForRework`）：Lead 的会话保留上下文，收到一条消息，列出分给它的缺口编号、
`why`、`suggested_source` 和主编写的 `brief`。

- Lead 可以自己补，也可以派专项搜索员：`briefing_delegate`（role `scout`，`gap: "G003"`）。专项搜索员单独计数
  （`max_gap_scouts_per_lead`，默认 2），不占第一轮的 `max_scouts_per_lead`。如果第 2 点的按来源分工已经落地，
  就按 `suggested_source` 派对应类型的搜索员。
- 搜索要用 `brief.py search` 记录下来，这样"搜过没有"才有据可查。
- Lead 在 `output.json` 里加 `gap_results`，每个缺口一条：

```json
{"gap_results": [
  {"gap_id": "G001", "outcome": "filled", "event_ids": ["E014"], "claim_ids": ["C031"]},
  {"gap_id": "G003", "outcome": "searched_none",
   "searched": ["federalregister.gov: 'affiliates rule' 2026-11", "bis.gov press releases"],
   "note": "No notice published in the window"},
  {"gap_id": "G005", "outcome": "not_reached", "reason": "time budget"}]}
```

- 交回时照常运行 `check_handoff.py --role lead`。新的接受结果替换旧的。已有的溯源检查保证第一轮的说法没有被悄悄删掉或改写。

## 8. 控制器怎么核对

确定性代码，不靠模型判断。核对结果写进 `RUN/gap_report.json`（智能体可读，不可写）：

| Lead 报的结局 | 控制器检查 | 通过 | 不通过 |
|---|---|---|---|
| `filled` | 列出的事件和说法存在，并且是重开之后新增的；还要符合缺口类型：`case_unfollowed` 要有带这个 `case_id` 的事件，`side_empty` 要有该边的新事件，`single_source` 要有一手来源，`discovery_unhandled` 要有候选里的某个网址，或者一条排除记录 | `filled` | `filled_unconfirmed`：写进签发单，交给审稿人 |
| `searched_none` | 重开之后至少新增 2 条 `search` 记录，并且至少有一条针对 `suggested_source` | `searched_none` | `not_searched` |
| `not_reached` | 有理由 | `not_reached` | — |
| 缺少这一条 | — | — | `not_reached`，理由写"Lead 未报告" |

Lead 失败或超时：它分到的缺口全部记为 `not_reached`，第一轮已经接受的结果保留，流程继续，不阻塞。

## 9. 结果怎么用

- **签发单**新增一栏"补搜"：每个缺口的类型、结局和理由；被跳过的 `case_unfollowed` 和 `side_empty` 放在最前面。
  人能在一分钟内看清"哪些查了没有、哪些没查"。
- **审稿人**拿到 `gap_report.json`。如果某个被跳过的缺口理由站不住，审稿人照常提 omission，走现有的返工流程。
- **运行摘要**（`qa/workflow_summary.md`）记录：算出的缺口数、补上、搜过没有、跳过、没来得及的各有多少，以及花了多少 token。
- 补搜结果不改变任何标签规则。新增的说法和其他说法一样，经过核验、校验和审稿。

## 10. 成本

| 项目 | 设定（初定，要在评估里调） |
|---|---|
| 重开的 Lead 的上限 | 8 万新 token（`gap_fresh_tokens`），从重开时算起；30 分钟 |
| 专项搜索员的上限 | 6 万新 token，15 分钟。11-06 搜索员实际用了 2.2 万–4.1 万 |
| 每次运行最多 | 补 8 个缺口；每个 Lead 最多 2 个专项搜索员；补 1 轮 |
| 预算预留 | 在 `reserve_fresh_tokens` 里新增 `gap_research` 40 万。第一轮研究不能动用；用法和现有的核验预留一样 |
| 没有缺口时 | 只花控制器运行一次 `brief.py gaps` 的时间 |

最坏情况是两位 Lead 各补满：2 ×（8 万 + 2 × 6 万）= 40 万，等于预留额。和 11-06 运行的总量（约 50 万新 token）比，
实际增加应该远低于这个数，要在评估里实测。预算不够时，补搜整体跳过，所有缺口记为 `not_reached`，原因写明，流程继续。

## 11. 要改哪些地方

**Skill**（预计约 1 周）

- `scripts/brief.py`：
  - 新命令 `gaps`，按第 5 节的规则输出 `gaps.json`；
  - `event add` 增加 `--category`（取值来自 `references/roles/categories.json`），供 `category_empty` 使用。
    旧记录没有类别时，这一类缺口不计算；
  - `build` 渲染签发单的"补搜"一栏。
- `scripts/check_handoff.py`：校验 `gap_plan.json`（主编）和 `gap_results`（Lead）的格式。
- `references/roles/chief-editor.md`：增加"缺口检查"一步。
- `references/roles/country-lead.md`：增加"补搜"一节。
- `references/roles/workflow.json`：增加 `gap_round`（`enabled`、`max_gaps_listed`、`max_gaps_pursued`、
  `max_gap_scouts_per_lead`），在 `task_fresh_tokens` 和 `reserve_fresh_tokens` 里增加对应项。
- 测试：每类缺口算出和不算出的情况；`filled` 核对通过和不通过；中文和英文渲染。

**Nex**（预计 1–1.5 周）

- `briefing-contracts.ts`：`gapPlanSchema`、Lead 输出里的 `gap_results`、`briefing_submit` 增加 kind `gap_plan`。
- `briefing-workflow.ts`：
  - 新阶段 `gap_review`；
  - `coverageGate`：运行 `brief.py gaps`，接受 `gap_plan`，重开 Lead，等待，核对，写 `gap_report.json`；
  - `briefing_delegate` 接受 `gap`，并按 `max_gap_scouts_per_lead` 计数；
  - 状态保存和重启恢复，做法照 `run.verification`；
  - 运行摘要。
- `briefing-budget.ts`：新增预算阶段 `gap` 和预留 `gap_research`。
- `docs/briefing-workflow.md`：补一节。
- 测试（脚本化）：
  - 没有缺口时直接进入核验；
  - 跳过缺口时没写理由被拒绝；
  - 补上并且核对通过；
  - 报了补上但核对不通过；
  - 搜过没有，以及搜索记录不足；
  - Lead 超时；
  - 预算不够时整体跳过；
  - 一边是部分运行；
  - 在每个保存点注入故障，测重启恢复；
  - 旧的 Skill 没有 `gap_round` 时，行为和现在完全一样。

**评估**（约 1 周，另加人工标注时间）：第 12 节。

## 12. 怎么证明它有用

和核验方案第 9 节用同一批样本：3–5 个已结束的时间窗口，冻结网页快照。

1. **人工参考清单**：每个窗口由人事先列好"应该出现的事件"，并标出哪些属于持续跟踪事项。
2. **故意制造缺口**：在固定样本上去掉某个持续跟踪事项的搜索结果、只留某个事件的媒体来源、让一个搜索员失败，看缺口检查能不能算出来。
3. **对比三组**，同一窗口、同一总预算：
   - A：现状（含核验），没有补搜；
   - B：A 加补搜，由主编决定补哪些；
   - C：B，但不让主编选，按优先级自动补前 8 个。用来看主编的取舍有没有价值。
4. **看这些数**：
   - 参考清单的召回率，持续跟踪事项单独统计；
   - 制造的缺口被算出来的比例；
   - 假缺口的比例（规则报了缺口，其实已经覆盖了）；
   - 结局分布：补上、搜过没有、跳过、没来得及；
   - 审稿人提出的 omission 数；
   - 新 token 用量和用时。

判断标准写在前面：B 的召回率明显高于 A、持续跟踪事项没有被无声漏掉、新 token 增加在 20% 以内，才默认开启；
否则保留为可选开关。不在评估用的样本上调规则和提示词。

## 13. 不做的事

- 不做第二轮补搜，也不让补搜结果再触发新的缺口检查。
- 不让主编直接派搜索员，也不让控制器替 Lead 写记录。
- 不把核验的 `not_found` 或审稿意见变成补搜任务。它们有各自的返工路径。
- 不用缺口数量给报告打分。"缺口少"不等于"覆盖全"。

## 14. 待定的问题（实现时的默认做法）

1. `discovery_unhandled` 只按网址匹配（忽略协议、`www.`、末尾斜杠和 `#` 后的部分），同一件事换了网址就会报成假缺口。
   是否接受这一点，让主编用 `skip` 加理由处理？还是在 Skill 里加标题相似度匹配（会带来漏报）？**现在：只按网址。**
2. 被跳过的 `case_unfollowed` 只写进签发单，还是应该阻止报告标为"可交人工签发"（ready_for_human_review）？**现在：只写进签发单。**
3. 第 10 节的上限都是估计，需要先在样本上跑一次，再定默认值。
4. 事件加 `category` 之后，第一轮的 Lead 和搜索员要多填一项。这个负担是否值得，还是先不做 `category_empty`？
   **现在：`--category` 可选；没有任何事件带类别时，这一类不计算，并写在 `skipped_types` 里。**

## 15. 实现和本文的差别

- **文件：** 控制器写两个文件，智能体只能读：`RUN/gaps.json`（算出的清单）和 `RUN/gap_report.json`（主编的决定、
  每个 Lead 重开时的基线、核对结果）。`brief.py gap-check` 读的就是 `gap_report.json`，没有另设 `gap_round.json`。
- **格式校验：** `gap_plan.json` 由 Nex 校验（每个缺口一条决定、跳过要理由、补的数量上限、无法分派的要给 `side`）。
  Lead 的 `gap_results` 两边都查：Nex 的格式校验和 `check_handoff.py --role lead`（`GAP_RESULTS`）。
- **分派：** 缺口按所属的一边交给那一边的 Lead；一边是 `both` 或 `other` 时，按事件来源（provenance）里的 Lead 分派；
  两者都没有的（例如中美双方的发现线索），主编在决定里写 `"side": "us"` 或 `"cn"`。
- **"搜过没有"的判定：** 重开后至少新记了 2 条 `brief.py search`，并且 `searched` 里至少列 2 条。
  第 8 节说的"至少有一条针对建议的来源类型"没有实现：搜索记录只是文字，没法可靠地判断针对的是哪类来源。
- **预算：** 补搜的上限和时间写在 `workflow.json` 的 `gap_round` 里（`lead_fresh_tokens` 8 万、`scout_fresh_tokens` 6 万、
  `lead_minutes` 30、`scout_minutes` 15、`discovery_top` 10）；预留是 `reserve_fresh_tokens.gap_research` 40 万，
  第一轮研究不能用，缺口检查一运行（不管有没有找到缺口）就释放。
- **Lead 补搜失败：** 缺口记为 `not_reached`。如果它的记录和第一轮交接时一样，第一轮的交接恢复为"已接受"；
  如果已经改动过，它保持失败，但第一轮已经合并进主编目录的研究仍算这一边的输入，写稿不需要 `partialReason`。
- **`single_source` 的范围：** 只看重要性为 high 的 `include` / `track` 事件。第 5 节说的"决定了状态标签的事件"没有单独算：
  状态标签取决于一手来源，没有一手来源的事件本来就不会显示为"官方确认"，这类说法已经由独立核验处理。
- **补搜期间：** 不能发跨境请求，要等这一轮结束。
- **测试：** Nex 的脚本化测试（`briefing-workflow.test.ts` 里的 `gap round` 一组）、预算和沙箱测试，
  以及用真实 Skill 脚本跑的一个完整补搜流程（`briefing-workflow.skill.test.ts`）；Skill 的 `tests/test_gaps.py`。
  第 12 节的样本评估和真实模型的实测都还没有做。
