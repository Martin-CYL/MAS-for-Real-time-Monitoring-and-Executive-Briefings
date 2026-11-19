# Nex

Nex 是面向日常办公场景的网页 AI 助手，提供简洁的对话界面，让用户通过自然语言发起任务、查看执行过程，并管理历史会话。项目目前处于内部开发与测试阶段。

## 主要功能

- **Agent 对话**：通过自然语言提出需求，查看任务执行过程与结果。
- **会话管理**：保存历史对话，继续已有任务。

## Overview

This repository holds three related pieces:

- **Nex**: the web workspace (React client, Bun server) that runs AI agent chats, with Codex App Server as the
  primary backend. This is what `main` contains.
- **The US-China AI and semiconductor briefing Skill** (`us-china-ai-chip-briefing`): research rules, an evidence
  ledger, an English HTML report template and validation scripts for an executive briefing. It is installed into a
  Codex skills directory and invoked from a Nex chat. It lives on separate branches, not on `main`.
- **The multi-agent briefing** (opt-in): Nex runs a chief editor, US and China leads, topic scouts and an
  independent reviewer as separate sandboxed agents, using the Skill. It is on feature branches, not merged.

| Capability | Branch | State |
|---|---|---|
| Nex web app | `main` | Merged |
| Single-agent briefing Skill | `latest-skill-20261015` | Separate Skill branch |
| Multi-agent briefing with security hardening | `feature/multi-agent-security-hardening` + `skill/multi-agent-security-hardening` | Pushed for review; not merged or deployed |

The Skill branches replace the whole file tree and must never be merged into `main`; see the
[branch map](docs/BRANCH_MAP.md).

## Documentation

| Read this | For |
|---|---|
| [AGENTS.md](AGENTS.md) | Build, test and merge rules (for people and coding agents) |
| [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) | What is implemented, tested and verified, blockers |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Planned work with acceptance criteria |
| [docs/BRANCH_MAP.md](docs/BRANCH_MAP.md) | Which branch holds what, and how branches relate |
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | How to start, finish, record and audit a task |
| [deployment/README.md](deployment/README.md) | Development and production environments |
| [docs/accounts.md](docs/accounts.md) | Invited-user account deployments |
| [docs/nex-sharing.md](docs/nex-sharing.md) | Read-only conversation sharing |

## Development

Uses Bun 1.4.2 (the version CI and `package.json` pin). See [AGENTS.md](AGENTS.md) for the full checks.

```sh
bun install --frozen-lockfile
bun run dev
bun run check
bun test --timeout 15000
```

## 致谢与许可

本项目基于 [Kanna](https://github.com/jakemor/kanna) 改造，保留原项目的许可证与必要署名。
使用及分发请遵循 [LICENSE](LICENSE)。
