# 给 Codex 的项目包

这不是新周报，而是将我们讨论的 Skill 放进 Codex 可直接工作的项目结构。

## 怎么使用
1. 下载并解压整个 ZIP；不要只打开压缩包内部的单个文件。
2. 在 ChatGPT 桌面应用顶部选择 **Codex**，选择 **打开本地文件夹 / Open folder**，并指向解压后的 `AI_Chip_Briefing_Codex_Project` 目录。也可以在 VS Code 的 Codex 扩展中打开此文件夹。
3. 新建任务，输入：`请阅读 AGENTS.md 和 TASK_FOR_CODEX.md，检查现有 Skill 与脚本，并完成 TASK_FOR_CODEX.md 规定的改造。先跑基线测试，再实现、运行测试并报告结果。不要生成新周报。`
4. 检查 Codex 修改的代码和测试结果，再决定是否将 Skill 安装到个人技能目录。

## 文件说明
- `AGENTS.md`: 给 Codex 的项目级说明。
- `TASK_FOR_CODEX.md`: 可直接执行的开发任务与验收条件。
- `.agents/skills/us-china-ai-chip-briefing/`: 你原先上传的 Skill；放在仓库局部 Skill 目录。
- `examples/V17_reference_2026-10-09.html`: 旧版样本，供 UI 对照和回归测试，不是最新事实来源。

第一次先完成“事实证据 + 脚本测试 + 审核报告”。多智能体编排是下一阶段。
