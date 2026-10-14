# Independent deployment environments

Development uses dev.nexbriefing.vip, port 3211 and /srv/nex/development/data.
Production will use nexbriefing.vip, port 3210 and /srv/nex/production/data,
and is deployed only after the user approves the main merge.
Each root contains nex/, codex/ and projects/. Never mount the other root or Docker socket.
Each environment has its own mode-600 .env and random password; UI language remains a browser preference.
Codex account quota is shared if both instances use the same account.

Run the shared compose file with a separate project and env file:

```sh
docker compose --env-file /srv/nex/development/.env -p nex-development -f /srv/nex/development/compose.yaml up -d --no-build
```

Prepare UID/GID 10001 data directories before startup. Snapshot the old data while
its container is stopped; preserve the original directories and old image for recovery.
Use an explicit image version. Never run down -v or delete data during upgrades.
Development starts from the existing test data. Production starts empty later.
Skills are independent within each codex/skills directory; publish only reviewed
complete skills, never share a writable skill directory across environments.
The compose file trusts forwarded HTTPS headers: keep the port loopback-only and
use host Caddy. The included Caddyfile routes both hosts; activate each route only after its service is healthy.

Validate password rejection, secure host-only cookies, anonymous API/file/WebSocket
rejection, real chat streaming, attachment downloads, logout and health checks.
Run full bun tests and bun run check before candidate deployment. Record the base
commit and source archive SHA256 when deploying uncommitted develop-martin code.
The first development deployment is a candidate for user acceptance, not a main release.
Future CD should deploy tested test commits to development and approved main commits
to production. No automatic deployment or merging is enabled by these files.
