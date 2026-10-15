# 质量检查与人工签核报告

- 生成时间（UTC）：2026-10-14T18:48:09.695745+00:00
- 总体状态：**FAIL**；不等于事实全部核验。
- HTML SHA-256：`3954dc857d70be3961f492b4c9a45d87013bd5c1630122bac38ece767fa3a37f`
- 台账 SHA-256：`94302655cb262f98b20b770db5d2cf9d3abd2ccda6a086fc0371789c3040bc73`
- 校验时钟：2030-01-02T18:00:00+00:00（injected fixture/test clock）
- 网络请求：本地模拟，未访问公共网络
- 本报告为 QA 工件，不得复制进管理层简报正文。

| 检查层 | 结果 | PASS | FAIL | UNVERIFIED |
|---|---|---:|---:|---:|
| report | FAIL | 1 | 7 | 1 |
| links | FAIL | 1 | 1 | 1 |
| quotes | FAIL | 0 | 2 | 0 |
| evidence | FAIL | 3 | 1 | 6 |
| coverage | UNVERIFIED | 0 | 0 | 1 |

## 就绪状态：BLOCKED

存在规则违反，修正后重新运行。

| 类别 | 数量 |
|---|---:|
| 规则违反（必须修正） | 11 |
| 作者可立即修正 | 2 |
| 证据缺失或不足 | 4 |
| 来源无法自动访问（不代表来源错误） | 1 |
| 需人工判断 | 0 |
| 等待最终人工签核 | 2 |

## 下一步：按顺序处理

| # | 类别 | 代码 | 定位 | 涉及文字 | 怎么做 |
|---:|---|---|---|---|---|
| 1 | 规则违反（必须修正） | SECTION_MISSING | 本期三个判断 | — | Add the missing section, copied from assets/template.html. （Required section missing: three headline judgments ("本期三个判断")） |
| 2 | 规则违反（必须修正） | SECTION_MISSING | 事件状态表 | — | Add the missing section, copied from assets/template.html. （Required section missing: event status table (<table> under "事件状态 / MONITORING STATUS")） |
| 3 | 规则违反（必须修正） | SECTION_MISSING | 管理层参考 | — | Add the missing section, copied from assets/template.html. （Required section missing: management view ("管理层参考")） |
| 4 | 规则违反（必须修正） | DATE_CONFLICT | — | — | Report-date mismatch: {'masthead': '2030-01-02', 'issue': '2030-01-03', 'footer': '2030-01-02', 'title': '2030-01-02', 'annotation:line2': '2030-01-02'} |
| 5 | 规则违反（必须修正） | FIGURE_DUPLICATE | — | — | Duplicate figure labels: [1, 1, 3] |
| 6 | 规则违反（必须修正） | FIGURE_SEQUENCE | — | — | Expected labels in order 1..3; found [1, 1, 3] |
| 7 | 规则违反（必须修正） | STATUS_LABELS_MISSING | — | — | Mark each story with one template status label (class "st confirmed\|reported\|pending"). （No template status labels (class "st confirmed\|reported\|pending"); custom badges are not checked against the legend） |
| 8 | 规则违反（必须修正） | BROKEN | https://fixture.invalid/dead | — | HTTP response only; source support not checked |
| 9 | 规则违反（必须修正） | QUOTE_NOT_FOUND | C001 | — | Copy the quote verbatim from the saved page text; never retype or translate it. （Page fetched (HTTP 200) but the recorded quote is not on it (best match 5%). Quote may be invented or from another page） |
| 10 | 规则违反（必须修正） | QUOTE_NOT_FOUND | C002 | — | Copy the quote verbatim from the saved page text; never retype or translate it. （Page fetched (HTTP 200) but the recorded quote is not on it (best match 0%). Quote may be invented or from another page） |
| 11 | 规则违反（必须修正） | CLAIM_UNSUPPORTED | C002 | — | 来源没有任何法律文本、管辖范围或生效日期，不能支持全球证券禁令；作者 supported 标签不可信。 |
| 12 | 作者可立即修正 | FIRST_USE | XYZ | — | Explain this term at its first visible use, e.g. "美国商务部工业与安全局（BIS）". （XYZ: explain at first visible use; later glossary does not count） |
| 13 | 作者可立即修正 | DATE_ORDER_AMBIGUOUS | review.signoff.date | — | 2030-01-02 and 2030-01-02 overlap at recorded precision; add source-backed time/offset if ordering matters |
| 14 | 证据缺失或不足 | COVERAGE_SWEEP_MISSING | — | — | Create coverage.json and record every candidate event and every active case with a decision. （No coverage.json: nobody can tell which major events were considered and left out） |
| 15 | 证据缺失或不足 | DATE_UNKNOWN | cutoff | — | Date is unknown; obtain it from the source or keep UNVERIFIED |
| 16 | 证据缺失或不足 | SYNTHETIC_FIXTURE | — | — | Synthetic fixture; not a news report or release candidate |
| 17 | 证据缺失或不足 | PRIMARY_LEGAL_SOURCE | C002 | — | Add the official instrument or list record (Federal Register, court filing, ministry notice) as a primary source. If it cannot be obtained, keep the claim worded as 据报, say in the report that the original was not obtained, and leave this for the reviewer. （Legal/list conclusion needs applicable original instrument or list record） |
| 18 | 来源无法自动访问（不代表来源错误） | BLOCKED | https://fixture.invalid/blocked | — | Not proof the source is wrong: the site refused automated access. Use a browser copy or an alternative source. （HTTP response only; source support not checked） |
| 19 | 等待最终人工签核 | COVERAGE_REVIEW | — | — | Human must check all material facts, including facts without claim markers |
| 20 | 等待最终人工签核 | HUMAN_SIGNOFF | — | — | Final human sign-off pending; no automatic VERIFIED label |

## 可执行发现

| 状态 | 检查代码 | 定位 | 说明 |
|---|---|---|---|
| FAIL | DATE_CONFLICT | — | Report-date mismatch: {'masthead': '2030-01-02', 'issue': '2030-01-03', 'footer': '2030-01-02', 'title': '2030-01-02', 'annotation:line2': '2030-01-02'} |
| UNVERIFIED | FIRST_USE | line 4 | XYZ: explain at first visible use; later glossary does not count |
| FAIL | FIGURE_DUPLICATE | — | Duplicate figure labels: [1, 1, 3] |
| FAIL | FIGURE_SEQUENCE | — | Expected labels in order 1..3; found [1, 1, 3] |
| FAIL | SECTION_MISSING | 本期三个判断 | Required section missing: three headline judgments ("本期三个判断") |
| FAIL | SECTION_MISSING | 事件状态表 | Required section missing: event status table (<table> under "事件状态 / MONITORING STATUS") |
| FAIL | SECTION_MISSING | 管理层参考 | Required section missing: management view ("管理层参考") |
| FAIL | STATUS_LABELS_MISSING | — | No template status labels (class "st confirmed\|reported\|pending"); custom badges are not checked against the legend |
| PASS | MECHANICAL_COMPLETE | — | Mechanical scan completed; missing facts and semantic status require reviewer |
| UNVERIFIED | BLOCKED | https://fixture.invalid/blocked | HTTP response only; source support not checked |
| FAIL | BROKEN | https://fixture.invalid/dead | HTTP response only; source support not checked |
| PASS | REACHABLE | https://fixture.invalid/source | HTTP response only; source support not checked |
| FAIL | QUOTE_NOT_FOUND | C001 | Page fetched (HTTP 200) but the recorded quote is not on it (best match 5%). Quote may be invented or from another page |
| FAIL | QUOTE_NOT_FOUND | C002 | Page fetched (HTTP 200) but the recorded quote is not on it (best match 0%). Quote may be invented or from another page |
| UNVERIFIED | DATE_UNKNOWN | cutoff | Date is unknown; obtain it from the source or keep UNVERIFIED |
| UNVERIFIED | DATE_ORDER_AMBIGUOUS | review.signoff.date | 2030-01-02 and 2030-01-02 overlap at recorded precision; add source-backed time/offset if ordering matters |
| PASS | DATE_SCAN_COMPLETE | — | Cross-field date scan completed; future event_date is allowed, unknown precision is not manufactured |
| UNVERIFIED | SYNTHETIC_FIXTURE | — | Synthetic fixture; not a news report or release candidate |
| PASS | TRACEABILITY_SCAN | — | Traceability scan executed; author labels and quotations are not proof |
| UNVERIFIED | PRIMARY_LEGAL_SOURCE | C002 | Legal/list conclusion needs applicable original instrument or list record |
| PASS | RECORDED_SOURCE_REVIEW | C001 | Independent source review recorded; semantic truth depends on reviewer |
| FAIL | CLAIM_UNSUPPORTED | C002 | 来源没有任何法律文本、管辖范围或生效日期，不能支持全球证券禁令；作者 supported 标签不可信。 |
| UNVERIFIED | COVERAGE_REVIEW | — | Human must check all material facts, including facts without claim markers |
| UNVERIFIED | HUMAN_SIGNOFF | — | Final human sign-off pending; no automatic VERIFIED label |
| UNVERIFIED | COVERAGE_SWEEP_MISSING | — | No coverage.json: nobody can tell which major events were considered and left out |

## 来源访问清单

| 类别 | 目标 HTTP | 代理 HTTP | URL |
|---|---|---|---|
| BLOCKED | 403 | — | https://fixture.invalid/blocked |
| BROKEN | 404 | — | https://fixture.invalid/dead |
| REACHABLE | 200 | — | https://fixture.invalid/source |

## 证据取得方式（自动核对 / 浏览器 / 未能打开 分开列示）

浏览器阅读与自动抓取同样只证明“作者看到了这段文字”；高风险 claim 无论哪种方式都须人工复核。

| Claim | 取得方式 | 访问状态 | 快照 | 摘录自动核对 | URL |
|---|---|---|---|---|---|
| C001 | 未记录 | opened | 无 | NOT_FOUND | https://fixture.invalid/source |
| C002 | 未记录 | opened | 无 | NOT_FOUND | https://fixture.invalid/source |

## 优先人工签核项

审核者重新打开来源并读相关段落，不能仅依赖作者的 supported 标签。优先检查以下事项；约十分钟是目标，不是时长保证。

- **C002** 风险分 15（legal, list, QUOTE_NOT_FOUND；摘录核对 NOT_FOUND） 所有芯片企业自 2030 年 1 月 2 日起均受全球证券交易禁令约束。
  - 来源：https://fixture.invalid/source；primary / other；访问 opened；核查 2030-01-02；定位 合成来源第 2 段
  - 不确定性：故意伪造法律结论，用于反例测试；作者标签有误。
- **C001** 风险分 10（QUOTE_NOT_FOUND；摘录核对 NOT_FOUND） 演示芯片在合成测试中完成 12 次运算。
  - 来源：https://fixture.invalid/source；primary / other；访问 opened；核查 2030-01-02；定位 合成来源第 1 段
  - 不确定性：仅用于测试，不可当作新闻事实。

- [ ] 法律：原始文件、管辖范围、发布／生效／拟议状态、期限及例外是否匹配？
- [ ] 名单／负面断言：准确名称与别名、具体名单版本、查询范围、查询日期和可复现的检索记录是否足够？
- [ ] 统计：单位、期间、币种、分母、可比口径和计算是否一致？
- [ ] 争议与企业回应：作者是否遗漏不同意见、回应日期或诉讼／审批的新状态？
- [ ] 技术：实测、公司宣称和推断是否分开，关键进展是否因缺乏直接银行风险联系而漏选？
- [ ] 全文：包括未加 claim ID 的事实；状态标签、解释、双边背景、重复表达及移动／打印布局是否妥当？
- [ ] 逐项处置全部 FAIL 与 UNVERIFIED，确定批准／暂缓／退回。

人工签核：姓名 ______ 日期 ______ 决定（批准／暂缓／退回）______
来源复核与异议：______；未解决项和理由：______

机器不会证明引用真实或足以支持法律结论。哈希只防止意外沿用旧记录，不验证签名人身份。
记录数字签核时使用 references/evidence-ledger.md 中的 review 格式；修改 HTML 或台账后重新审核。
