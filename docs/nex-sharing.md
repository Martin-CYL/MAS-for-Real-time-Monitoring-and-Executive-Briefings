# Nex conversation sharing

New shares are immutable snapshots hosted by the same Nex server at `/share/<random-token>/`.
They are stored in `<runtime-data-dir>/shares/`; no third-party sharing service is contacted.
The UI resolves the returned relative URL against the current browser origin, so a deployed
Nex domain is used automatically. Preserve this data directory across server deployments.
Reverse proxies must forward `/share/*` as well as normal application routes.

The normal Share action includes visible user messages and assistant replies. It excludes
attachment file contents, tool activity, reasoning, provider/session records, and debug payloads.
Attachment names can still appear as unavailable metadata. User-authored text is not a secret
scanner: review its content before creating a link. The creation dialog explains this boundary.
A snapshot does not change when the original conversation changes.

Anyone possessing a share link can read it without the application's login. Tokens contain
192 bits of randomness. These routes only support GET/HEAD, reject path/symlink escapes,
and disable caching and indexing. Explicit bundled attachments through the export command
are forced downloads rather than executable pages. No listing endpoint exists.

A localhost link only works on the server's own computer. External sharing requires deploying
Nex to a reachable HTTPS domain; no tunnel or public deployment is enabled by this change.
Existing links on the former upstream service are not updated: create a new Nex link to use the
new branding. Existing snapshots use their captured viewer assets.

Expiry, revocation UI, recipient-specific permissions and attachment selection are not yet
implemented. An operator can revoke a local snapshot by moving its token directory out of
`shares`; this does not revoke any copies recipients have already saved.
