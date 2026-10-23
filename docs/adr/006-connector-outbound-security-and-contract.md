# ADR 006: Connector outbound security, HTTP lifecycle, and contract hardening

- **Status:** Accepted for Phase 3
- **Date:** 2026-10-23

## Context

Phase 3 introduces tenant-configured CRM connectors. `GenericRestConnector` turns tenant data (base URL, paths, mappings, secret references) into outbound requests carrying credentials, which makes it the platform's main SSRF and credential-exfiltration surface ([ADR 002](002-specification-reconciliation.md)). The inherited draft had a half-applied HTTP-client refactor that did not compile, and closed each undici dispatcher before reading the response body. undici's `close()` waits for in-flight requests, and a request stays in flight until its body ends, so large responses stalled until the abort timer fired. The draft also had other defects: tenant config could select a `permissive` policy that disabled address checks, secret references could name any process environment variable, path parameters were not encoded, writes were retried, and credentials were forwarded across redirects.

## Decision

**HTTP transport and dispatcher ownership.** `RestHttpClient` uses `Agent.request()` from the installed `undici` package rather than the global `fetch`. Node's bundled undici (8.x on Node 26) and the npm package (7.30.1) are different versions, and the client must not mix them. `send()` owns every dispatcher it creates: one pinned `Agent` per hop (`connections: 1`). The hop's dispatcher is released in a `finally`: graceful `close()` once the body has been fully read (or a redirect body dumped), `destroy()` on any failure. Release errors go to `onCleanupError` and never replace the request outcome. Responses are fully buffered under `maxResponseBytes`, so no stream or socket escapes `send()`. One deadline covers DNS (raced, because `dns.lookup` cannot be aborted), every hop, and body consumption. Caller cancellation is distinguished from timeouts.

**DNS pinning.** Each hop resolves the hostname once and normalises the answer (IP syntax, family 4/6, family/syntax agreement). It rejects the hop if any address is restricted, then connects through `connect.lookup`, which answers only with those addresses and honours a requested family. IP-literal hosts are validated directly (Node skips lookup for them). There is no unpinned fallback. undici passes the original hostname as `host` to `tls.connect`, so SNI and certificate verification use the URL hostname while the socket connects to the pinned IP; `rejectUnauthorized: true` is forced. Restricted ranges cover IPv4 private, loopback, link-local/metadata, CGNAT, documentation, benchmarking and multicast space, plus IPv6 `::/8`. IPv6 forms that embed IPv4 (mapped, NAT64, 6to4) are judged by the embedded address, and Teredo, ULA, link/site-local and all multicast are blocked.

**Redirects.** Redirects are never followed by the transport. Tenant connectors default to 0 redirects (configurable up to 5). Every hop is fully re-validated and re-pinned, STRICT requires `https`, cross-origin hops drop every caller-supplied header, request bodies never cross origins, and the previous body is consumed or cancelled before its dispatcher is released.

**Policy ownership.** The outbound policy is a deployment setting (`CONNECTOR_OUTBOUND_POLICY`, `strict` by default and required in production), not tenant data. Loopback exemptions and replacement trust anchors exist only as code-level options for tests, accept only exact loopback addresses, and are refused when `NODE_ENV=production`. The mock connector (fictional prices) is not registered in production.

**Secrets.** `EnvSecretResolver` resolves only `env:CONNECTOR_SECRET_<NAME>`; platform variables such as `POSTGRES_PASSWORD` or `TELEGRAM_BOT_TOKEN` are unreachable from connector configuration. Unresolved secrets fail before any request.

**Contract.** Per AGENTS.md §5.2, a connector method is present only when its operation is configured; capabilities derive from endpoints (`search` requires the search endpoint). The registry checks each instance's advertised capabilities against both its methods and its registration, and replaces cached instances when the configuration fingerprint changes. Field mappings are per entity with closed key sets. Paths follow own properties only, values are type-checked rather than coerced, and every record is validated against the canonical schema. Upstream identities are checked against the requested item or offer. Search filters must map to configured parameters or be rejected. Path parameters are URL-encoded and confined under the base URL.

**Resilience.** Reads retry transient failures with bounded backoff and never earlier than `Retry-After`. Writes (`createLead`, `updateLead`, `createBooking`) are attempted once, because a timeout can hide a committed write; durable lead retry belongs to Phase 5. The circuit breaker is per tenant and connector, counts only transient failures, resets on success, and admits a bounded number of half-open trials. Listing either completes or fails: reaching `maxPages` with more data pending is an error, never a truncated catalog.

**Sync core.** Catalog snapshots are all-or-nothing. Missing records are deactivated, never deleted. A run that would deactivate more than half the active items, or that returns no offers at all, is refused without an explicit operator override. Offers are reconciled only when the connector can list them. Synced prices are search copies, not live quotes (D10).

## Consequences

- Each request pays a fresh TCP/TLS handshake because pinned dispatchers are not pooled. Acceptable for v1 volumes; a later pool must be keyed by the validated address set and expire with DNS TTL.
- The GenericRest config contract changed from the unreleased draft (no `outboundUrlPolicy`, per-entity `fieldMappings`, `searchParams`, `catalogItemType`). No persisted configs or consumers existed.
- Write bodies use the canonical `LeadInput`/`BookingInput` shape plus static endpoint fields. CRMs that need another shape need outbound field mapping or a custom connector.
- Without an upstream quote id, a quote is identified by its offer id.
- Environment secrets are deployment-wide; per-tenant secret scoping requires a tenant-aware resolver behind the same interface.
- Sync persistence (run status table, tenant-scoped upserts) and BullMQ scheduling are not implemented yet; see `docs/PROGRESS.md`.
