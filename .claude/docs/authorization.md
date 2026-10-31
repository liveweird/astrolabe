### Authorization model

Layered RBAC. Implemented in the `server/src/main/kotlin/authz/` package.

- **Global roles are an additive set**: every user is implicitly a regular user (USER is the
  baseline — never transmitted), and additional roles — currently only `ADMIN` (`UserRole` in
  `users/User.kt`; a future role is just a new enum value) — only ever ADD privileges. The API
  carries them as a `roles` array (`[]` = regular user); `isAdmin()` (`authz/Guards.kt`) =
  `ADMIN ∈ roles`. Storage is a single `users.role` column with a CHECK (V1) — the **wire shape is
  already the set** (`roles` claim + `LoginResponse.roles`), so moving to a Lettuce-style
  `user_roles` join table when a second additional role arrives never breaks issued tokens or
  clients. **ADMIN is the management role**: it owns the whole user-management surface (the
  `/users` CRUD below) and may reset any user's password (`requireSelfOrAdmin`'s admin branch);
  the management surfaces attach to it (users and, with flat teams, team CRUD and membership).
- **Login** issues a **pair** of JWTs, both carrying `email`, `userId`, a `roles` array claim, a
  `credentialRevision` and a `typ` claim (`"access"` / `"refresh"`), minted by `auth/Tokens.kt`
  (`JwtConfig.issueAccessToken` / `issueRefreshToken`). The short-lived **access** token
  (`jwt.accessExpiresInSeconds`, default 900) is the API bearer; the longer-lived **refresh**
  token (`jwt.refreshExpiresInSeconds`, default 3600) is exchanged at `POST /api/v1/refresh` for a
  fresh pair. `LoginResponse` (also the `/refresh` response) exposes `token`/`expiresAt`,
  `refreshToken`/`refreshExpiresAt`, `userId`, and `roles`. The `jwt {}` verifier in
  `plugins/Security.kt` additionally requires `typ == "access"` and runs the per-request account check
  (`TokenBlocklistService.accessVerdict`: one uncached statement - non-revoked `jti`, user exists and not deleted,
  `credentialRevision` and `roles` equal the stored ones; `security.md` "JWT model"), so a refresh token cannot
  authenticate an API call and a stale access token is a `401` on its very next request.
- **Session auto-extension (pure sliding).** `/api/v1/refresh` (rate-limited, no `authenticate` —
  the access token may be expired) verifies the refresh token's signature/issuer/audience/`typ`/
  non-revocation, then does **one** `userService.read(userId)` to confirm the user is still active
  (soft-delete-filtered) and pick up their current roles/email, **requires the signed
  refresh-token `credentialRevision` to equal `users.credential_revision`**. Every password
  change/reset/bootstrap rotation increments that revision atomically with the hash update, so
  even changes in the same millisecond invalidate earlier credentials. Missing or malformed
  revision claims are rejected. The refresh token is **rotated**: after those checks pass, its `jti` is claimed
  with one atomic insert into the blocklist (`TokenBlocklistService.claimRefresh`, until the token's own expiry) and a fresh
  pair is minted - only the claim is atomic, not the delivery of the response. So it works once; a replay inside the
  60-second grace (`security.refresh.replayGraceSeconds`; covers a lost response and the loser of two racing tabs) is
  answered with another pair (at most twice per token, and a logout that reaches the route ends the grace of that user's rotations) and audited
  `refresh.replay_grace`, a replay after it is the uniform `401` with
  `refresh.rejected reason=replayed` (`revoked` stays for logout-revoked tokens; the grace/records are in memory,
  per instance, and a restart falls back to strict - `security.md` "Token storage"). There is no family-wide revocation; the superseded access token lives until its own expiry; an idle session (no refresh
  within the refresh TTL) ends, as does one hit by a password change/reset or account delete (`security.md` "Token storage"
  states the consequence). Every rejection is audited (`refresh.rejected` with `reason`). Frontend:
  `web/src/api/http.ts` `authedFetch` silently refreshes (single-flighted within the current
  session, and serialised across tabs by a Web Lock where the browser has one) and retries once on a `401`; a refresh rejected because another tab already
  rotated the pair adopts the pair in storage instead of signing out; on a definitive refresh rejection it clears only the
  session that initiated the request. Responses from an obsolete session cannot publish
  credentials, clear a newer session, or retry an operation as the newer account. Logout clears
  local credentials immediately and revokes its captured token pair best-effort; when its access token has expired
  (`/logout` needs one) it renews the pair detached from the cleared session and revokes the NEW pair.
- **The public surface** is exactly seven operations, each declaring `security: []` in the spec:
  `POST /login`, `/login/mfa`, `/refresh`, `/password-reset`, `/password-reset/confirm`, and the two probes
  `GET /api/v1/health` (liveness — the process answers) and `GET /api/v1/ready` (readiness — a
  database round trip within a short budget, else `503`; `plugins/Health.kt`). Probes disclose
  nothing but `{status: ok}`; everything else sits inside `authenticate {}` (`AnonymousAccessTest`
  sweeps it from the spec — the "401 sweep": every operation without a declared `security: []` is
  probed token-less, so a new route is covered the moment its spec entry lands).
- **A reset token authorizes exactly one thing**: replacing that one account's password through
  `POST /password-reset/confirm`, never a bearer-authenticated call. The confirm checks the grant before validating the
  password (a uniform `401` for an unknown, expired, used or stale grant, so `401` wins over `400`), then rechecks expiry,
  the credential revision and the email under a user-row lock while it consumes the grant and writes the password in one
  transaction. Confirmation invalidates every session of the account and any pending MFA challenge; normal sign-in,
  including enabled MFA, still follows. The authenticated ADMIN password `PUT` is unchanged. Details: `security.md`
  "Self-service password reset by confirm link".
- **Guards** in `authz/Guards.kt` are plain `suspend`-friendly function calls used at the top of
  each route handler — there is no Ktor plugin or DSL. Each route reads `call.caller()` (which
  parses the JWT claims into a `CallerPrincipal{userId, email, roles}` — missing/unknown claims
  throw `UnauthorizedException`) and then invokes the relevant guard: `isAdmin(caller)`,
  `requireAdmin(caller)`, `requireSelfOrAdmin(caller, targetUserId)`, `requireTeamManagerOrAdmin(caller, teamId,
  isManager)` (ADMIN, or the team's ACTIVE manager via the injected `TeamService.isActiveManager` lookup, which
  answers false for a missing team so the 403 is uniform — awaiting its first consumer, the v0.5 capacity writes), plus
  `requireFeatureEnabled` (awaiting its first area-gating consumer); new guards join this file so the whole policy stays
  in one place.
- **Resource rules**:
  - `/api/v1/users` (list/create) and `PUT`/`DELETE /api/v1/users/{id}` → **ADMIN only** — the
    whole management surface is admin-gated (the list included; regular users keep only the self
    password change). `GET /users/{id}` → target user or ADMIN, **guard-before-read** (an
    unauthorized caller 403s uniformly whether or not the id exists). Two protections with a
    deliberate 403/409 split: **self-delete is a `ForbiddenException` (403)** — a
    permissions-shaped rule about WHO acts — while **deleting or demoting the LAST active
    administrator is a `ConflictException` (409)** — a state-shaped rule about what the system
    can afford to lose. Initial passwords are client-generated (the SPA) and stored only as
    bcrypt hashes; no response carries plaintext.
  - `/api/v1/teams` (V6, flat teams) → `GET` list and `GET /{id}` **any authenticated user**
    (teams are the ownership unit the planning features point at: the Teams page reads
    them); `POST` and `PUT`/`DELETE /{id}` **ADMIN only**, with `requireAdmin` BEFORE the body decodes and the
    id lookup (guard-before-read: a non-admin probe gets a uniform 403 whether or not the id exists, and a
    non-admin's malformed body stays 403). A
    case-insensitive name clash with an active team `409` (the V6 partial index). The optional
    `managerUserId` (create and the full-replace PUT — omitted = no manager) must be an ACTIVE user,
    else `400` ("Unknown or deleted manager ids"); `TeamResponse`/`TeamListItem` carry `managerUserId` +
    `managerName`, both null for a soft-deleted manager. Being a team's manager grants NO write on the team
    record itself (still ADMIN only) — the manager's rights are the team-scoped ones the planning increments add
    (capacity, milestone scheduling, team order; `product.md`), via `requireTeamManagerOrAdmin`. From v0.2 the manager is a
    person of the people directory (`teams.manager_person_id` replaces `manager_user_id`). Mutations audit `team.created/updated/deleted` and `team.manager_changed`
    (only on an actual change). Tests: `TeamTest`, `GuardsTest`.
  - `PUT /api/v1/users/{id}/features` → ADMIN only; **self allowed** (an admin adjusting their own
    flags is a feature, and the users routes are never gated, so a fully self-disabled admin can
    always get back); unknown/soft-deleted target → 404; unknown feature name → 400 (enum
    decode); wholesale replace (idempotent — same-set re-PUT is 204, not 409); audited
    `user.features_changed` (featuresFrom/featuresTo) only on an actual change. **Per-user feature
    flags (V5, Lettuce's model)**: `Feature { MFA }` stored as the DISABLED set
    (`user_disabled_features`, no row = enabled). **`MFA` is inverted-default and login-scoped** —
    every user starts with the MFA row present (the V5 seed + the `UserService.create`
    chokepoint), so email MFA is opt-in; it gates the LOGIN FLOW only, and no route names it in
    `requireFeatureEnabled` (which awaits the first area-gating feature; run it as the FIRST
    guard when one arrives — before any read, so a disabled caller gets a uniform 403 even for a
    missing id). Mind the wholesale-replace PUT: a disabled set omitting MFA — including the
    empty "re-enable everything" array — ENABLES the second factor. The set rides both JWTs as
    the `disabledFeatures` claim (missing claim = empty — outstanding tokens survive the deploy;
    unknown value = 401) and `LoginResponse`/`UserResponse.disabledFeatures`, so a change takes
    effect at the target's next refresh (≤15 min) or login. Users list:
    `feature=<F>&featureEnabled=true|false` filter pair (must come together, 400 otherwise). SPA:
    `hasFeature()` (`api/session.ts`, localStorage `astrolabe.auth.disabledFeatures`), the per-user
    editor `/users/:id/features` (the Users table's Features button) and the admin per-feature
    screen `/feature-flags` (state filter + bulk enable/disable over every row matching the
    current filters, behind a count-stating confirm — a client-side loop of the same per-user
    wholesale PUTs). Tests: `FeatureFlagsTest` + the GuardsTest/AuditTest cases.
  - `PUT /api/v1/users/{id}/language` → **target user or ADMIN** (`requireSelfOrAdmin`, the V1
    `language` column — Lettuce's model): the ONE synced per-user language, set at create
    (`UserCreateRequest.language`, default `"en"`), applied to the SPA at sign-in (rides
    `LoginResponse`, applied by `persistSession` on login/MFA/refresh) and used for every email
    sent to the user (read fresh at send time). The header language switcher is the self-service
    writer (fire-and-forget save on switch); the whole-user PUT deliberately never touches it.
    Unsupported code → 400 (after the guard — 403 wins); idempotent; audited
    `user.language_changed` on an actual change. Tests: `UserLanguageTest`.
  - `PUT /api/v1/users/{id}/password` → target user or ADMIN (`requireSelfOrAdmin`). New password
    must be ≥ 10 chars (`MIN_PASSWORD_LENGTH` in `users/UserRoutes.kt`) and ≤ 71 UTF-8 bytes
    (`MAX_PASSWORD_BYTES`, `auth/Passwords.kt` — the bcrypt ceiling), else `400`. A **self-change**
    (even by an admin) additionally requires a correct `currentPassword` in the body (else `403`,
    audited `password.change_denied`) — checked BEFORE the length validation, so 403 wins over
    400 (the convention everywhere); an admin resetting **another** user's password does not. A
    successful change stamps `users.password_changed_at` and atomically increments
    `users.credential_revision`, which invalidates all outstanding refresh tokens and pending MFA
    challenges (see "Session auto-extension") and, through the per-request revision check, every outstanding
    ACCESS token too - the token a self-change was made with is a `401` on the next request (the SPA signs out
    explicitly). Covered by `PasswordChangeTest` and `StaleAccessTokenTest`.
  - **A delete, a demotion/promotion or a password change takes effect on the account's very next request.** An
    access token's `jwt {}` validation (`plugins/Security.kt`) runs ONE uncached statement over the user row
    (`TokenBlocklistService.accessVerdict`): a soft-deleted user is `401` (`access.rejected reason=user_gone`), a token
    whose `roles` differ from the stored role is `401` `roles_changed` (the SPA's `401` -> `/refresh` then succeeds
    with the NEW roles and re-renders; a delete or password change makes the refresh fail too, which signs the user
    out), a changed `credentialRevision` is `401` `credential_changed`, a logged-out `jti` is `401` `revoked`. The
    `ADMIN` guards therefore never run on a stale role, `caller()` still reads `roles`/`disabledFeatures` off the (now
    verified) claims, and `disabledFeatures` alone still lags to the next refresh (`FeatureFlagsTest`). Over HTTP the
    caller of `DELETE /users/{id}` is therefore always an active admin, so the last-admin `409` is reachable only
    as a race (the caller deleted between the access check and the locked admin count; pinned with a lock-wait test in
    `UserRoutesTest`) - the self-delete `403` is the HTTP answer.
  - **The team-manager grant is checked in the database on every request too, by its own predicate.**
    `requireTeamManagerOrAdmin` asks `TeamService.isActiveManager` (an ACTIVE team whose `manager_user_id` is the caller
    AND an ACTIVE user) per request, so assigning or clearing a manager takes effect on the very next request (a
    soft-deleted manager's token is already a `401` at the access check; the ACTIVE-user predicate stays as the second
    line); its ADMIN short-circuit rides the (verified) JWT roles. Never cache the verdict in a claim. A route that merely
    SHAPES its answer by the grant (e.g. whether a block of per-person figures is returned) asks `isActiveManager` the same way, after
    the ADMIN short-circuit; the `ETag` of such an answer carries the verdict ("Caching" in `security.md`). No route consumes the guard in v0.1.0; it is
    the Flow-donated seam for the v0.5 capacity writes, and v0.2 re-points it at `manager_person_id` → `people.user_id`.
  - **Planned (v0.2+), not yet built — the owner-scoped matrix** (`product.md` "Domain decisions"): ADMIN everything; ownership cascades down (work stream
    → program → project); a project owner edits the project and its milestones' plan fields but not their dates; milestone dates only by the team's manager or
    ADMIN; the global rank by ADMIN plus the per-user `ROADMAP_EDITOR` grant (a `user_permissions` row checked in the database per request, NOT a feature
    flag); a team manager edits capacity and team order; reads open to every authenticated user. Each new rule lands here with its guard order
    (403 before 400/404, guard-before-read where existence is sensitive) in the same commit as its route.
- **Existence disclosure (403 vs 404) — deliberate policy (API-ERR-006)**: two sanctioned idioms,
  and every new resource picks one consciously rather than mixing them. **Guard-before-read**
  (`GET /users/{id}`): a forbidden caller gets a uniform 403 whether or not the id exists — use it
  where existence itself is sensitive. **Read-before-guard**: missing → 404, existing-but-
  forbidden → 403 — acceptable where ids are sequential and existence is no secret. The password
  PUT effectively guards first (`requireSelfOrAdmin` needs no read), then maps a zero-row update
  to 404 — safe because the only callers past the guard are the target and admins.
- **Audit on denial**: every 403 emits `authz.denied` (method/path/byUserId/detail) from the
  `ForbiddenException` handler in `plugins/ErrorHandling.kt` — denials are part of the security
  trail, and route code gets it for free by **throwing**, never hand-rolling a 403 response. See
  "Audit trail" in `.claude/docs/observability.md`.
  - `GET /api/v1/telemetry/current` and `GET /api/v1/telemetry/history?group=&range=` (`telemetry/TelemetryRoutes.kt`) → **ADMIN only, read-only**
    (operational data: process sizes, container limits, request figures). `requireAdmin(call.caller())` is the first
    statement, before the query is read, so a non-admin gets the uniform `403` for a bad or missing `group`/`range` too (`403` outranks `400`);
    only then is an unknown, missing, blank or repeated `group` / `range` a `400`. No mutation, so no audit event of its own (a denial is the
    generic `authz.denied`); both ride the per-user `telemetry` rate bucket (30/min, mounted inside `authenticate`; `security.md` "Telemetry").
    See `.claude/docs/observability.md` "Telemetry" for the shapes. Tests: `TelemetryRoutesTest`.
- **Exceptions**: `UnauthorizedException` (→ 401), `ForbiddenException` (→ 403),
  `NotFoundException` (→ 404), `ConflictException` (→ 409), and `TooManyRequestsException` (→ 429) live
  in `authz/Exceptions.kt` and are mapped in `plugins/ErrorHandling.kt`. **All error bodies are
  RFC 7807 `application/problem+json` (API-ERR-001/002)**
  (`ProblemDetail{type,title,status,detail,instance}`; `instance` defaults to the request path
  without query parameters) — emit them via the `ApplicationCall.respondProblem(status, detail)`
  helper (it uses an explicit `TextContent` so ContentNegotiation does not relabel the media type
  as `application/json`). `StatusPages` routes `BadRequestException`→400 (**with fixed vocabulary
  for converter failures**: a `ContentConvertException` anywhere in the cause chain
  (ContentNegotiation's malformed-JSON wrap, whose raw message carries the target FQCN) answers
  "Request body is invalid or does not match the expected schema", and the Resources decode wrap
  "Can't transform call to resource" answers "Path or query parameter is malformed"; our
  validators' own messages, cause-less, pass through), `CannotTransformContentToTypeException`→400
  when Content-Type is absent, otherwise →415 for an unsupported request media type (the abstract
  ContentTransformationException parent is deliberately not caught), the typed exceptions as above
  (**the route 404 convention**: read preambles and zero-row mutation results
  `throw NotFoundException("<Resource> not found")` — never a hand-rolled
  `respondProblem(NotFound, …)` + return), unique-violation `23505`→409 and NUL-byte `22021`→400
  (via the R2DBC/Exposed cause-chain walkers), and a catch-all `Throwable`→500 (logged) through
  that helper. A `status(TooManyRequests)` handler additionally gives the `RateLimit`
  plugin's bodiless 429 (per-IP buckets, and the per-USER `telemetry` bucket) a generic problem body and emits the `rate_limit.exceeded` audit event
  (bucket/method/path, coalesced to one per bucket per minute with a `suppressed` count — per user, with `byUserId`, for the `telemetry` bucket —
  `observability.md`) — **that handler rewrites any non-StatusPages
  429**, which is why caller-specific 429s (the login lockout) must go through
  `TooManyRequestsException` (handled calls are marked and skipped) — and a sibling
  `status(MethodNotAllowed)` handler gives routing's bodiless wrong-method 405 a problem body too
  (no `Allow` header — Ktor doesn't surface the allowed-method set; test with the default client,
  the conformance plugin would rightly flag the out-of-spec operation). The SPA fallback
  (`plugins/Routing.kt`, only when `web.staticDir` is set) never answers under `/api` (or `/api`
  itself): an interceptor on its route node throws `NotFoundException`, so an unknown API path is
  the standard 404 problem body, never index.html (a wrong method on a declared `/api` path is then a 404 too, not
  405 — the 405 handler answers only when no `staticDir` is served) (`ServerTest` covers it WITH a `staticDir`,
  through the default client — the conformance plugin would flag the undeclared path). A pre-routing intercept in
  `configureErrorHandling` additionally 400s any `/api/` path with a negative-integer segment
  (kotlinx decodes `UInt` via `toInt().toUInt()`, so `/users/-1` would WRAP to 4294967295 and flow
  into the normal lookup instead of failing as the spec's `minimum: 0` promises). The JWT
  `challenge` in `plugins/Security.kt` also calls `respondProblem` (it runs outside
  `StatusPages`). Test HTTP clients must register the `application/problem+json` content type
  (`json(contentType = ContentType.parse("application/problem+json"))`) to decode error bodies
  with `body<ProblemDetail>()` — the shared test-client defaults do.
- **Tests**: `GuardsTest` covers the guard matrix, `AnonymousAccessTest` sweeps the 401 surface
  FROM THE SPEC (plus the forged-secret and jti-less token cases), `UserRoutesTest` the management
  CRUD + protections (with `TestUsers.withSoloAdmins` isolating the last-admin 409s in the shared
  container), `PasswordChangeTest` the self-vs-admin rules, `AuditTest` the denial and mutation
  events. The shared `TestUsers.seed` helper defaults to `role = UserRole.ADMIN` so privileged
  fixtures are terse; pass `role = UserRole.USER` when you need a non-privileged caller.

### Not yet ported from Lettuce

- **The HR read-only auditor role** (audited `hr.read`/`hr.list` cross-user reads) — with it,
  Lettuce's rule that every HR-privileged read is audit-logged.
- **The management-chain rule** (`teams/ManagementChain.kt` — transitive manager rights) —
  **deliberately NOT ported**: Astrolabe's teams are flat (ONE optional direct manager, no
  chain, no succession history). Port only if a hierarchy of teams ever becomes a requirement.