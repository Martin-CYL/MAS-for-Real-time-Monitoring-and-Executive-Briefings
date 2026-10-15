# Public HTTP boundary and temporal validation

These are deterministic QA controls, not AI fact verification. Preserve FAIL / UNVERIFIED / scoped PASS. The production CLI exposes no policy-disabling switch, untrusted resolver override or fixture clock override for real ledgers. Its only network option is `--strict-network`, which makes the policy stricter.

## Public-source HTTP only

`safe_http.py` is the network boundary used by `check_links.py`. Before any request:

1. Parse canonical HTTP(S), reject userinfo, controls, backslashes, malformed hosts/ports, percent-encoded host ambiguity and IPv6 zone identifiers.
2. Reject localhost/internal/single-label hostnames, all non-public IPv4/IPv6 destinations, loopback, RFC1918/ULA, link-local/metadata, CGNAT, multicast, unspecified/reserved/documentation ranges and ambiguous numeric IPv4 forms (integer/octal/hex/short forms). IPv4-mapped IPv6 is checked against the embedded IPv4 address. NAT64/6to4/Teredo ranges are conservatively rejected.
3. For DNS names, inspect **every** A/AAAA candidate. A single non-public/scoped address rejects the whole answer. A DNS failure is UNVERIFIED, not proof of a dead source.
4. Connect to one validated numeric sockaddr, preserving the original hostname in HTTP Host and HTTPS SNI. Verify the connected peer and retain standard CA/hostname verification. Disable automatic `http.client` reconnection by hostname. No second mutable DNS lookup is used for that connection.
5. Follow at most five redirects manually. Revalidate syntax, literals and all DNS candidates before every next connection, including same-host, relative and protocol-relative Locations. Loops, missing Locations, excessive redirects and HTTPS downgrade remain UNVERIFIED. A redirect to a non-public target is FAIL, and no request is made to that target.

Public IP classification is a conservative eligibility rule, not evidence the website is trustworthy, supports a claim, or belongs to the public Internet under every routing arrangement. Rare legitimate transition-network endpoints are intentionally unsupported. Explicit conservative blocks also cover 192.0.0.0/24, 192.88.99.0/24, 2001::/23, 3fff::/20 and 5f00::/16, avoiding known differences in special-purpose classifications between supported Python versions. Globally reachable protocol-service exceptions within these special prefixes are intentionally unsupported; maintain this policy as registries and runtimes evolve.

### Proxy behaviour (changed in the merged version)

Corporate and bank networks usually force traffic through a proxy. Refusing all proxied requests would switch off every link and quote check there, so the default is now:

- **Default (`BRIEFING_PROXY_POLICY=allow`):** requests go through the environment proxy. The URL text of every hop is still checked (private and special IPs, localhost, internal names, odd numeric forms), redirects are still followed manually with each `Location` checked before it is requested, and HTTPS downgrades are refused. DNS cannot be pinned because the proxy resolves names, so a public-looking hostname that resolves to a private address is not detected. Rely on the network's own egress controls for that. Findings record `transport: proxy`.
- **Strict (`--strict-network` or `BRIEFING_PROXY_POLICY=refuse`):** the original fail-closed behaviour. With a proxy present, requests are refused as UNVERIFIED/UNCHECKED and nothing is sent.
- Without a proxy, behaviour is unchanged: DNS is pinned on every hop as described above.

Use strict mode when the checker runs on a server that can reach internal systems. For a writer's laptop or a demo, the default is adequate, and source snapshots (see `evidence-ledger.md`) let quote checks run with no network at all.

Other trust limits are unchanged. DNS pinning reduces application-level rebinding/TOCTOU; it does not prove network routing, proxy/OS integrity, resolver authenticity or source truth. A public front end may itself proxy private content. Public HTTP is unencrypted; prefer HTTPS primary sources. Stdlib DNS resolution may exceed the per-socket timeout. Limits are per hop with at most six attempted hops.

`resolver`, `transport`, and the compatibility `opener` adapter are **trusted test hooks**, not inputs from articles or ledgers. Mocks perform one hop and never follow redirects internally. The CLI exposes none of them.

### Result semantics

| Condition | Result | Exit contribution |
|---|---|---:|
| Private/non-public URL or DNS/redirect target, unsafe notation | FAIL / UNSAFE_URL | 1 |
| Actual destination 404/410 | FAIL / BROKEN | 1 |
| Actual destination 401/402/403/407/429/451, recognized interstitial | UNVERIFIED / BLOCKED | 2 if no FAIL |
| DNS/TLS/timeout/transport or 5xx/408 | UNVERIFIED / NETWORK_ERROR | 2 if no FAIL |
| Strict mode with a proxy, unresolved redirect/offline inventory | UNVERIFIED / UNCHECKED | 2 if no FAIL |
| Final 2xx, without detected block/soft error | PASS / REACHABLE for HTTP only | 0 only for performed scope |

A proxy response is not a destination response. No request is made to internal services or metadata even in regression tests; all changed network scenarios use Mock.

## Date/time interchange and logic

Keep v1 fields. Add metadata when it is known:

```json
{
  "report_date": "2030-01-02",
  "timezone": "Asia/Hong_Kong",
  "generated_at": "2030-01-02T16:30:00+08:00",
  "cutoff": "2030-01-01",
  "claims": []
}
```

This is a format illustration, not a valid report ledger (claims cannot be empty). A report date stays YYYY-MM-DD. Source `publication_date` / `date_checked`, independent review date/signoff date, and metadata cutoff/generated_at can be ISO dates or timestamps, with explicit precision and offset. A missing source date may remain null and is UNVERIFIED. `event_date` describes the event, not publication, and may be in the future; it is not used to infer a source-check chronology.

- Legacy date-only fields use UTC unless `ledger.timezone` provides an IANA zone. This is a declared v1 convention, not a guess about the publisher. Record the actual publisher/report timezone where available.
- Offset-bearing timestamps normalize to UTC. A naive local timestamp needs explicit `ledger.timezone`; ambiguous/nonexistent DST times are UNVERIFIED and need an explicit offset. IANA zones need system timezone data (or the platform's tzdata); UTC requires no extra library. Missing timezone data is UNVERIFIED, never silently guessed.
- A date-only observation is a calendar-day interval, including 23/25-hour DST days. Minute/second/fractional timestamps retain their own precision. Clearly disjoint reversed intervals FAIL; overlap that cannot establish ordering is UNVERIFIED. Equal timestamp intervals at different equivalent offsets are treated as the same recorded instant. Same-day date-only publication/checking cannot establish intraday order and is UNVERIFIED, not FAIL.
- `date_checked` for an opened source must not precede publication. Opened or blocked checks in the future relative to the actual runtime FAIL. A date-only check today is not falsely declared future because the day has not ended.
- Generated time must fit report_date; clearly future generation/report times FAIL. Cutoff cannot be after generation; coarse overlapping metadata needs clarification. Visible full cutoff is compared to ledger.cutoff; a partial month/day is compared only when the ledger supplies the full date. No missing year is fabricated.
- Source publication after cutoff is UNVERIFIED and needs attribution/reviewer eligibility decision or an updated cutoff. Exact cutoff vs date-only publication needs precision review. A source checked after the original generation is UNVERIFIED unless source `recheck_reason` explicitly documents historical revalidation; that note does not excuse checks in the future or change the original cutoff.
- Review/sign-off times are checked against runtime, and sign-off must not precede the review. Impossible source dates prevent a recorded source-support PASS. Other temporal findings remain visible even with a recorded human approval.

Older ledgers missing cutoff/generated_at remain readable: report_date supplies coarse generation precision; missing cutoff and unresolved comparisons remain UNVERIFIED. JSON Schema documents shape; semantic chronology is enforced by `check_dates.py` through `check_evidence.py` and the aggregate validator.

### Reproducible fixture clock

Actual ledgers always use runtime. `--as-of 2030-01-02T18:00:00Z` is allowed only with explicit `fixture: true`; it is printed in QA metadata and cannot authorize a real release. Passing a fixture clock never disables chronological comparisons. It avoids static 2030 fixture dates being misrepresented as already checked in a real 2026 run. Trusted Python unit tests can inject `now`; do not expose that hook to untrusted workflow inputs.

```sh
python3 scripts/validate.py tests/fixtures/synthetic_report.html --ledger tests/fixtures/inconsistent_dates_ledger.json --as-of 2030-01-02T18:00:00Z --output-dir date-error-qa
python3 scripts/check_links.py tests/fixtures/unsafe_source_report.html --network --json unsafe-source.json
```

Both commands intentionally return 1. The second rejects the metadata address **before any DNS/socket request**. Missing/uncertain dates return 2 with actionable claim ID, JSON field/index, cause and suggested correction. Neither fixture is a new weekly report.
