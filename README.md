# AI Chip Briefing — Skill hardening project

> **第三轮合并版**：在第二轮基础上合入日期一致性检查和网络安全层，并新增来源快照（离线核对摘录）和默认允许代理。先读 `CHANGE_SUMMARY_第三轮合并_中文.md`。
>
> **第二轮改造（Claude 审阅后）**：新增原文摘录自动核对、风险分级（低风险自动通过）、Markdown 人工签核单、事件覆盖清单、恢复的跟踪案例与编辑规则。先读 `CHANGE_SUMMARY_第二轮_中文.md`。


本包完成事实证据、检查脚本、反例回归测试和人工签核工件改造。未生成新周报，也未上传仓库。先读 `CHANGE_SUMMARY_中文.md`；实际 Skill 位于 `.agents/skills/us-china-ai-chip-briefing/`。

从项目根目录运行：

```sh
python3 -m unittest discover -s .agents/skills/us-china-ai-chip-briefing/tests -v
python3 .agents/skills/us-china-ai-chip-briefing/scripts/validate.py examples/V17_reference_2026-10-09.html --date 2026-10-09 --glossary .agents/skills/us-china-ai-chip-briefing/references/glossary.md --output-dir qa-output
```

第二条是离线历史回归检查，预期退出码 2（UNVERIFIED）：V17 没有逐条证据台账或独立签核，所有链接未联网核查。不可视为事实认证。

实际报告的单条命令（在 Skill 目录内运行）：

```sh
python3 scripts/validate.py /path/report.html --ledger /path/evidence_ledger.json --coverage /path/coverage.json \
  --date YYYY-MM-DD --glossary references/glossary.md --network --output-dir /path/qa-output
```

输出 `review_report.md`（全部发现）和 `signoff.md`（只列高风险事项的人工签核单）。审核人在 `signoff.md` 中打勾、填写姓名日期后，加 `--signoff /path/qa-output/signoff.md` 重新运行。仍兼容原来的 `--review` JSON。标准库即可运行；完整语义、可选浏览器测试与 Single-Agent MVP 用法见 Skill 的 `README.md`。

`evaluation/` 保存基线、最终测试和质量报告示例；`examples/V17_reference_2026-10-09.html` 原文件保留不变，仅供历史 UI 与回归对照。`AGENTS.md` 与 `TASK_FOR_CODEX.md` 为原始项目任务文件，未改动。
