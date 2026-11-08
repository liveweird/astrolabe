### The Flow sync (v1.5.0, in progress)

Read before touching `flow/`, `FlowOrigins`, the Flow stub or the Flow pages. **What it is:** Astrolabe reads Flow (the sibling app) through its read-only service token and mirrors one document - every team with its dated members and its sprints - into typed tables; **nothing is ever written to Flow**. The connection registry, Test connection, the run, the status and polling are built (C1-C5); team binding, the capacity import and the roster are the later 1.5 steps and get their sections when they land. **It is proven against the built-in Flow stub only and not yet against a real Flow** (the plan's first real-Flow walk-through is the first real test). The shape is `jira-sync.md`'s on purpose: read it for the registry, the scheduler and the status, which are the SAME code (`sync/`).
Related: schema `persistence.md` ("The Flow sync tables (V24)"); outbound guard `security.md` "The Flow consumer"; audit events and the run log lines `observability.md` ("Sync runs", "The Flow run"); per-route guards `authorization.md`; the stub `sample-data/flow/README.md`.

## Who may do what

| Call | Guard |
|---|---|
| `…/integrations/flow/connections` (CRUD), `…/connections/test`, `…/{id}/test` | ADMIN, `requireAdmin` BEFORE the body (guard-before-read); reads included (a connection names a credential-bearing Flow) |
| `POST /integrations/sync/runs {kind: FLOW, connectionId}` (Refresh now) | ADMIN; `202` with the unfinished run; `400` for an unknown, deleted or disabled connection; audited `flow.sync_requested` |
| `GET /integrations/sync/runs?kind=FLOW&connectionId=` | any authenticated user (a run names no secret) |

Rate bucket: `flow-test` 10/min per IP (`FLOW_TEST_RATE_LIMIT_PER_MINUTE`, 1..100; the e2e stacks pin 30), Test connection only, its own bucket (a Flow test never spends a Jira one). A run, a poll and a refresh ride no bucket (one call, serialised by the claim).

## The transport

Flow is the sibling app, reached over `GET /api/v1/integration/me` and `GET /api/v1/integration/teams?sprintsSince=YYYY-MM-DD` with `Authorization: Bearer flow_int_<43 base64url>`. The allow-list is OPERATOR configuration (`flow.*`, `security.md` "The Flow consumer"): a connection's `baseUrl` is exactly one listed origin and its identity (a `PUT` with another is `409`). The wire contract is written in two places that must agree and are proven aligned by `FlowClientTest` and `FlowStubFixtureTest`: `flow/FlowDocument.kt` (the decoder) and `sample-data/flow/contract.mjs` (the stub's builders). Failure codes (`FetchException.code`): `AUTHENTICATION_FAILED` (401: Flow's one uniform answer - revoked, expired or wrong), `NOT_FOUND` (a Flow older than 1.57.0), `UPSTREAM_UNAVAILABLE` (5xx), `RATE_LIMITED` (429), `REDIRECT`, `LIMIT_EXCEEDED` (the 1 MiB response cap), `INVALID_RESPONSE`, `TIMEOUT`, `BLOCKED_HOST`. Config (`flow.*`, env `FLOW_*`): `requestTimeoutSeconds` 30, `requestDeadlineSeconds` 60, `maxResponseBytes` 1 MiB, `maxConcurrentRequests` 1, `maxRetries` 2, `sprintsSinceDays` 365 (30..1095).

## Test connection and the probes

`FlowConnector.testConnection` runs two required probes in sequence (10 s each, 30 s in all, never throwing; every outcome is a row, **never a 502**): `me` (the token is live; `NOT_FOUND` carries the hint "Flow 1.57.0 or later") and `teams` (the document decodes; the result adds "N teams, M sprints" and `truncated`; `SKIPPED` when `me` failed), plus the one `stored_token` row (`TOKEN_UNREADABLE`) when the stored token cannot be decrypted. `POST …/{id}/test` records `last_tested_at/ok` unless the row was edited meanwhile (`recorded`) and audits `flow.connection_tested`. **Test connection never writes the mirror**: the run is its single writer; a passing test is what makes the connection pollable, so the first run follows within a tick.

## The run

`FlowObserver` (the `Connector` of kind `FLOW`, registered by `configureFlow`) does, per claimed run: read the connection and its token in one short transaction (`FlowConnectionService.readForRun`, the second of the two decrypting readers) - then NO database transaction is open until the call has returned; ONE `GET /integration/teams?sprintsSince=` where `sprintsSince` is today in the CONNECTION's zone minus `flow.sprintsSinceDays`; `FlowMirrorStore.replace` in one transaction, which re-reads the connection under its row lock (`FOR NO KEY UPDATE`) and writes nothing when it was deleted (`GONE`) or disabled (`DISABLED`) meanwhile. It OBSERVES: no plan lock, no revision, nothing sent to Flow beyond the one GET.

| Situation | Run | Mirror |
|---|---|---|
| a document | `SUCCEEDED`; `observed` = teams, `gone` = ACTIVE bindings whose Flow team the document lacks, `calls` = 1 | replaced wholesale, `teams_at` stamped |
| `401` | `FAILED` `AUTHENTICATION_FAILED` (a revoked or expired token; rotate it with a `PUT`: that makes the connection due at once) | keeps its last document |
| `5xx` / `429` | `FAILED` `UPSTREAM_UNAVAILABLE` / `RATE_LIMITED`, then the registry's doubling back-off (one interval, doubling, capped at 6 h) plus the deterministic jitter | keeps its last document |
| a body that is not the contract | `FAILED` `INVALID_RESPONSE` | keeps its last document |
| unreadable token / unknown zone | `FAILED` `TOKEN_UNREADABLE` / `TIME_ZONE_INVALID`, no call | untouched |
| connection deleted / disabled while the call was in flight (judged under the row lock at the write: `FlowMirrorWrite.GONE` / `DISABLED`) | `FAILED` `CONNECTION_GONE` / `CONNECTION_DISABLED` | nothing written (a deleted connection's mirror and token are already gone; a disabled one keeps its last document and `teams_at`) |
| `sprintsTruncated` | `SUCCEEDED` + a WARN (counts only) | the document Flow sent is kept |
| `teamsTruncated` | `SUCCEEDED` + a WARN; `gone` is **0** | the teams it carries are replaced, **every other mirrored team is kept whole** |

**The `teamsTruncated` rule.** Flow caps a document at 1,000 teams (and 2,000 sprints). A team absent from a truncated document was merely not sent, so it is neither deleted from the mirror nor counted `gone` (and the panel and 1.6's `TEAM_GONE`, which derive `gone` from the mirror, never see it vanish); the next complete document is authoritative. The cost: a team really removed from Flow stays mirrored while Flow keeps truncating. `FlowRunWireTest` pins it (three documents: complete, truncated, complete).

**The token never appears** in a log line, an audit, a run row or a problem body: the run's error text is fixed (`Flow fetch failed: {code} ({status})`, never the exception message, which quotes a URL), `clampErrorDetail` is only the backstop, and `FlowRunWireTest`, `SyncRunRoutesTest` assert it with a ROOT `LogCapture`.

## Polling and status

Polling is the 1.3 scheduler unchanged (`observability.md` "Sync runs"); Flow's parts: the default interval is **60 minutes** (5..1440, `null` = manual only; STALE after 3 intervals, so 3 h), `ready` = a Test connection passed (`last_test_ok`) OR a run has mirrored a document (`teams_at`) - sticky like Jira's `discovered_at`, so a token or zone `PUT` (which clears the test verdict) or a Test that hit a Flow outage never stops a connection that has run from polling; a never-tested, never-run connection is not polled, `changedAt` = the later of `updated_at` and `last_tested_at`, so a rotated token or a fresh passing test makes the connection due at once whatever a back-off says. `pollRows` (`FlowConnectionPolling.kt`) reads eight columns and never the token. Every connection answers a derived `status` and `lastRun` (`SyncStatusKernels.derive`, the same rule and readers as Jira's: the registry, the telemetry `sync` block; nothing is stored). Proven by `FlowRunTest` (the stub: NEVER_SYNCED to CURRENT, the mirror equals `sample-data/flow/expected.json`, day two drops Billing and counts the bound team gone, an outage, a revoked token), `FlowRunWireTest` (MockEngine), `FlowConnectionStatusTest`, `SyncSchedulerTest` ("a tested Flow connection is polled, an untested one is not") and `TelemetryRoutesTest`.

## The token's life

Encrypted at write (`FieldCipher`, `enc:v1:` envelope), write-only on the wire (`hasApiToken`), masked in every `toString` (`SecretToStringTest`), decrypted in memory by exactly two readers in `FlowConnectionService`: `readForTest` and `readForRun`. A `PUT` with a token rotates it; a changed token or zone clears `last_tested_at/ok`. Deleting a connection sets the column to NULL, soft-deletes its bindings and removes its runs and mirror in one transaction.

## Assumptions ledger

"Stub-only" means NOT verified against a real Flow 1.57.0 (the contract is `~/.claude/plans/flow-service-token.md` §3.1).

| # | Assumption | Status | Where it shows |
|---|---|---|---|
| F1 | The document's field names and types equal the Flow plan §3.1. The decoder is **strict on lists and flags** (`items`, `members`, `sprints`, `teamsTruncated`, `sprintsTruncated`, `hasCalendar` are required: an absent one reads as drift, never "empty" or "false") and **lenient on nullable scalars** (Flow encodes without defaults, so it OMITS a null: `expiresAt`, `validTo`, a missing capacity decode like a sent null) | stub-only; the stub's builders (`contract.mjs`) are the other half | `INVALID_RESPONSE` on a missing required member; the `teams` probe row |
| F-T | Flow caps a document at 1,000 teams and sets `teamsTruncated`; a team absent from such a document still exists | field found on Flow's `feat/service-token` branch 2026-11-08, stub-only | the WARN; `gone` 0; the mirror keeps its teams |
