# Nex accounts (development rollout)

An authentication gateway uses Better Auth and SQLite for email/password sessions. Public signup and password-reset requests are disabled. A server administrator creates accounts and one-time password setup/reset links; SMTP is not configured. Links expire after one hour. Password reset revokes existing sessions.

Each account has a separate Nex container, Codex home, application data and workspace. The gateway routes HTTP and WebSocket requests using the authenticated user ID. Tenant containers do not expose ports and join separate Docker networks. Only the gateway binds the host loopback port; Caddy supplies HTTPS. Production and development use separate databases, secrets and deployment directories.

This isolates application data and local agent processes; containers share the host kernel, and using one Codex subscription still shares its account and quota. It is intended for trusted invited testers, not untrusted public code execution. Do not mount the Docker socket or host credentials into users' containers. Explicitly created read-only share links remain accessible to anyone with that link.

## Deployment and administration

Build the app with the normal Docker target, and the gateway with `docker build --target gateway -t nex-gateway:TAG .`. Use immutable release tags. On the host:

```sh
sudo python3 scripts/nex-accounts.py /srv/nex/development/accounts-stack init \
  --origin https://dev.nexbriefing.vip \
  --app-image nex-web:TAG --gateway-image nex-gateway:TAG --port 3211
```

Before migration, check that no task is running, stop the old development service, and back up its entire data directory. Preserve the original directory. Import existing data only into the administrator's account:

```sh
sudo python3 scripts/nex-accounts.py /srv/nex/development/accounts-stack invite ADMIN_EMAIL \
  --name Martin --import-data /srv/nex/development/data
```

For a new account, omit `--import-data`. An administrator can supply `--codex-auth /protected/path/auth.json` to bootstrap the shared Codex account. Only that credential file is copied, never another user's chat history. Provision reviewed Skills separately into each user's Codex skills directory; do not copy another user's entire Codex home. Updating a Skill should be tested in development before replacing the independent production copy.

```sh
sudo python3 scripts/nex-accounts.py /srv/nex/development/accounts-stack activate
```

The command prints the new user ID and a protected file path containing the setup link. Share that link privately with its intended recipient. Treat it as a password; never commit it, put it in logs, or publish it. For a fresh link:

```sh
sudo python3 scripts/nex-accounts.py /srv/nex/development/accounts-stack reset USER_EMAIL
```

After adding users, run `activate` again. It reloads the tenant registry and opens each user’s default workspace. Use `--skills-dir` with an approved Skill release directory to copy independent initial Skills when inviting a user. The generated configuration and registry contain internal service passwords and must remain mode 600 outside Git. Application data belongs to UID 10001; account database files belong to UID 10002.

For rollback, stop the accounts Compose stack, then restart the original development Compose service on port 3211. Imported histories and later activity in the new stack remain intact, but post-migration activity is not automatically copied back. Do not run both versions against the same data directories.

## Testing

`bun test src/server/gateway/gateway.test.ts` covers routing, authentication, one-time reset, session revocation, origin checks and WebSocket logout. Also run the full suite and `bun run check`. Before live use, verify two separate browser sessions, cross-account session/file URLs, preserved administrator history, an empty new account, and a real agent task in each container. Never interpret HTTP 200 alone as authorization success: some frontend routes return the app shell.
