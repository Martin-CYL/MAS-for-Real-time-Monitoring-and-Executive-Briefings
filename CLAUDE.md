# Nex development notes

Nex is a web workspace for research and executive briefings. The React frontend and Bun server communicate over a WebSocket. AgentCoordinator and provider adapters translate agent events into shared transcript snapshots. Codex App Server is the primary configured backend; other adapters remain for compatibility.

- `bun run check`: TypeScript check and client, export-viewer, server builds.
- `bun test --timeout 15000`: full unit/integration suite.
- `bun run dev`: local Vite and backend development.
- `bun run start:production --host 127.0.0.1 --port 3210 --no-open`: built web server.

Production application data lives in `~/.nex`; the dev profile uses `~/.nex-dev`. Codex state stays in `CODEX_HOME` or `~/.codex`. Do not check credentials, runtime state or user messages into Git. Preserve the upstream LICENSE and attribution in README.md.

There is no desktop application, npm release workflow, automatic application updater or hosted cloud pairing service. Hidden Git/terminal/provider code remains in use by underlying workflows. Keep the existing bilingual UI and local read-only sharing behavior. This is currently a single-user service.

Docker validation is deferred until server deployment. Do not infer that the image works from successful local web tests. Do not modify Skills as part of repository cleanup.
