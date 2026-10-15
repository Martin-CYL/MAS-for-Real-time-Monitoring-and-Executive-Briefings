# Nex development notes

Nex is a web workspace for research and executive briefings. The React frontend and Bun server communicate over a WebSocket. AgentCoordinator and provider adapters translate agent events into shared transcript snapshots. Codex App Server is the primary configured backend; other adapters remain for compatibility.

- `bun run check`: TypeScript check and client, export-viewer, server builds.
- `bun test --timeout 15000`: full unit/integration suite.
- Before declaring code changes validated, run the full test suite and `bun run check`; targeted tests alone are insufficient. Add browser verification for user-facing behavior changes. Report Linux CI and Docker checks separately when they have not run.
- For a bug fix, replay the original user scenario end to end after the fix and present the result for user acceptance before merging into `test`. Passing automated tests alone is not acceptance.
- Merging into `main` requires the user's explicit confirmation for that merge. Prepare the PR and report validation results, then wait; do not merge `main` automatically.
- `bun run dev`: local Vite and backend development.
- `bun run start:production --host 127.0.0.1 --port 3210 --no-open`: built web server.

Production application data lives in `~/.nex`; the dev profile uses `~/.nex-dev`. Codex state stays in `CODEX_HOME` or `~/.codex`. Do not check credentials, runtime state or user messages into Git. Preserve the upstream LICENSE and attribution in README.md.

There is no desktop application, npm release workflow, automatic application updater or hosted cloud pairing service. Hidden Git/terminal/provider code remains in use by underlying workflows. Keep the existing bilingual UI and local read-only sharing behavior. The core app is a single-workspace service. Optional account-gateway deployments run a separate app container and data directories for each invited user; see docs/accounts.md.

Docker validation is deferred until server deployment. Do not infer that the image works from successful local web tests. Do not modify Skills as part of repository cleanup.
