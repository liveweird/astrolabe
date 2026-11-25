# Authorization

Owns: who may call what: roles and permissions, the guards of `authz/Guards.kt`, the guard order of every route (403 before 400 and 404, guard-before-read, read-before-guard, existence disclosure), the `can` flags and the error mapping. Not here: token, refresh and lockout mechanics (`security.md`), the audit events (`observability.md`), the plan lock (`planning-model.md` "The lock protocol"), what the Jira import computes (`jira-sync.md` "Import").

Layered RBAC in `server/src/main/kotlin/authz/`.

## Rules

- **Roles, permissions and feature flags are three mechanisms** ("Roles vs permissions"). Roles (`ADMIN`) ride the JWT and are verified against `users.role` on every request; permissions (`ROADMAP_EDITOR`) are database rows read per request and NEVER a claim; feature flags are a DISABLED set riding the token. ADMIN only ever ADDS privileges and owns every registry (users, people, teams, public holidays, the Jira and Flow connections, telemetry).
- **Never cache a verdict in a claim.** The team-manager grant, the caller's person and a permission are asked of the database per request, so a grant or a revoke takes effect on the target's next request.
- **A guard is a plain function call at the top of the handler** (`call.caller()`, then the guard), not a Ktor plugin. New guards join `authz/Guards.kt` so the whole policy stays in one place, each pure-tested in `GuardsTest`.
- **403 before 400 and 404, and a forbidden caller's malformed body stays 403:** the guard runs before `call.receive`. A rate bucket on a per-user route node (`password-change`, `jira-bind`, `jira-import`, `sync-run`, `telemetry`, `schedule-proposal-save`) answers `429` before the guard.
- **Two idioms for existence, every new resource picks one** (API-ERR-006). Guard-before-read: a forbidden caller gets a uniform 403 whether or not the id exists; use it where existence is sensitive or the resource has no owner chain (users, teams, people, holidays, baselines, the ranking, the Jira and Flow registries, telemetry, sync runs). 
  Read-before-guard: missing is `404` for EVERY caller, existing-but-forbidden is `403`; acceptable where ids are sequential and every login reads the plan (plan nodes, milestones, dependencies, team-scoped writes, bindings, a team set listed in a body, a saved proposal's delete).
- **The body-first exceptions are named, and only these:** `POST /integrations/jira/bindings` and `POST /integrations/flow/team-bindings` (the node or team is IN the body), the four cross-team POSTs (the run, the accept, the check and the proposal save: the team set is in the body), the Jira import preview and apply (connection, then body, then targets).
- **After the guard, `PUT /users/{id}/password` checks the new password's rules (400) before the current password (403):** otherwise the status would tell a right guess from a wrong one, an oracle ("Users").
- **The owner-chain, team-manager and grant guards run twice on a write under a lock.** Outside, before `call.receive`, for the 404 → 403 → 400 ordering; again INSIDE the transaction against what is re-read under the lock (chain, person `FOR SHARE`, grant, manager). Only the inner verdict authorizes the write; its failure is a `403` with nothing written and no revision bump (a request can be held open after the outer guard: a slow body, a wait at the lock). ADMIN-only registries are not re-guarded (the plan lock is not an authorization);
  the proposal save re-runs its guard under its table lock.
- **A state rule comes after the guard and the body.** The `409`s for a stale revision or scope and `stale-deviations` are decided against what is stored, under the lock. The others keep their own place: the bind's no-discovery and `jira-mapping-invalid` `409`s before its transaction, the preview's `409`s without a lock, a name clash from a unique index.
- **A 403 is thrown, never hand-rolled** (`ForbiddenException` emits `authz.denied`); a 404 is `throw NotFoundException("<Resource> not found")`. Every error body is RFC 7807 through `respondProblem` ("Exceptions and the problem mapping").
- **The public surface is exactly seven operations**, each `security: []`; `AnonymousAccessTest` sweeps everything else for a 401 from the spec.
- **A `can` flag is a hint, the write's guard decides.** The flags come from the pure `planning/PlanPermissions.kt` with the SAME arithmetic as the guards, pinned against them table-driven (`PlanPermissionsTest`) and against the real writes by the view tests.
- **Reads of the plan are open to every authenticated user.** A view discloses nothing a login cannot read elsewhere, or states the new disclosure and why.
- **A connection registry is ADMIN only on every operation, reads included;** its token is write-only (accepted on create and update, never returned, never in an audit line, a log line or a problem body).
- **A new rule lands here** with its guard order, in the same commit as its route, its tests and its spec entry.

## Roles vs permissions

- USER is the baseline, never transmitted: the API carries the additional roles as a `roles` array (`[]` = regular user); `isAdmin()` = `ADMIN ∈ roles`. **Roles** (`ADMIN`) ride the JWT and are verified against `users.role` on every request, so a role change is a `401 roles_changed` on the very next request.
- Storage is a single `users.role` column with a CHECK (V1); the wire shape is already the set (`roles` claim, `LoginResponse.roles`), so a second additional role is a new `UserRole` value and breaks no issued token or client.
- **Permissions** (`Permission` in `users/User.kt`, today `ROADMAP_EDITOR`) are **rows of `user_permissions` read per request** (`UserService.hasPermission`), never a claim, never cached: a grant or a revoke takes effect on the next request with no refresh, no re-login and no `401`.
- They are not the V5 feature flags (a DISABLED set, default-on, riding the token): a permission is an additive GRANT, default-off. `CallerPrincipal` carries no permissions; a guard that needs one takes the lookup as an injected `suspend (userId, Permission) -> Boolean` (the `requireTeamManagerOrAdmin` shape), keeping `GuardsTest` pure.
- **Feature flags** (V5): `Feature { MFA }` stored as the DISABLED set (`user_disabled_features`, no row = enabled). The set rides both JWTs as the `disabledFeatures` claim (missing claim = empty, so outstanding tokens survive a deploy; an unknown value is `401`) and `LoginResponse`/`UserResponse.disabledFeatures`. A change takes effect at the target's next refresh (at most 15 minutes) or login.
- **`MFA` is inverted-default and login-scoped:** every user starts with the MFA row present (the V5 seed and the `UserService.create` chokepoint), so email MFA is opt-in; it gates the LOGIN FLOW only. No route names a feature in `requireFeatureEnabled`; the first area-gating feature runs it as the FIRST guard, before any read, so a disabled caller gets a uniform 403 even for a missing id.

## Tokens and sessions

Mechanics (claims, the access check and its `401` reasons, refresh rotation and replay grace, logout, the reset link): `security.md` "JWT model", "Refresh replay grace" and "Self-service password reset by confirm link". Defaults: access token 900 s (`jwt.accessExpiresInSeconds`), refresh token 3600 s (`jwt.refreshExpiresInSeconds`).

- **A delete, a role change or a password change takes effect on the account's very next request:** `401` with `user_gone`, `roles_changed`, `credential_changed` or (a logged-out `jti`) `revoked`. The SPA's `401` → `/refresh` then succeeds with the NEW roles; a delete or a password change makes the refresh fail too, which signs the user out. `caller()` reads `roles`/`disabledFeatures` off the verified claims, so the `ADMIN` guards never run on a stale role and `disabledFeatures` alone lags to the next refresh (`FeatureFlagsTest`).
- **A reset token authorizes exactly one thing:** replacing that account's password through `POST /password-reset/confirm`, never a bearer-authenticated call. The confirm checks the grant before validating the password (a uniform `401` for an unknown, expired, used or stale grant, so `401` wins over `400`) and invalidates every session of the account; the ADMIN password `PUT` is unchanged.
- The SPA side (`authedFetch`, the single-flighted refresh, logout): `web/CLAUDE.md`, `web-internals.md`.

## The public surface

Exactly seven operations, each declaring `security: []` in the spec: `POST /login`, `/login/mfa`, `/refresh`, `/password-reset`, `/password-reset/confirm`, and the probes `GET /api/v1/health` (liveness) and `GET /api/v1/ready` (readiness: a database round trip within a short budget, else `503`; `plugins/Health.kt`). Probes disclose nothing but `{status: ok}`.

Everything else sits inside `authenticate {}`; the 401 sweep covers a new route the moment its spec entry lands.

## Guards

`authz/Guards.kt`. Each route reads `call.caller()` (it parses the JWT claims into `CallerPrincipal{userId, email, roles}`; missing or unknown claims throw `UnauthorizedException`) and then calls its guard. The table is the whole policy.

| Guard | Passes |
|---|---|
| `isAdmin(caller)`, `requireAdmin(caller)` | `ADMIN ∈ roles` |
| `requireSelfOrAdmin(caller, targetUserId)` | the target user, or ADMIN |
| `requireFeatureEnabled` | a caller with the feature enabled; no consumer yet |
| `requireTeamManagerOrAdmin(caller, teamId, isManager)` | ADMIN, or the team's ACTIVE manager through the injected `TeamService.isActiveManager`, which answers false for a missing team so the 403 is uniform |
| `requireTeamManagerOfAllOrAdmin(caller, teamIds, managedTeamIds)` | the same right over a body-listed SET: ADMIN, or every team in the one `activeManagedTeamIds` lookup |
| `requireRoadmapEditorOrAdmin(caller, hasPermission)` | ADMIN (short-circuits without the lookup), or the `ROADMAP_EDITOR` grant; a throwing lookup propagates (fails closed) |
| `requireOwnerOrAdmin(caller, callerPersonId, chain)` | ADMIN, or the caller's person is on the node's `OwnerChain` (work stream, program, project owners top-down); a caller with no active person owns nothing |
| `requireAncestorOwnerOrAdmin(caller, callerPersonId, chain)` | ADMIN, or an owner ABOVE the node (`chain.ancestors`); the node's own owner alone is refused |
| `requireTargetWindowEditorOrAdmin(caller, callerPersonId, chain, hasPermission)` | given the node's FULL chain: ADMIN, an owner ABOVE the project, or the grant; the project's own owner alone is refused; the person-id check runs before the database lookup |
| `requireOwnerOrTeamManagerOrAdmin(caller, callerPersonId, chain, teamId, isManager)` | `requireOwnerOrAdmin`'s arithmetic, or the ACTIVE manager of `teamId`, the node's STORED team (null for a program or project binding: nothing changes there); the person-id check runs before the lookup; the kernel twin `PlanPermissions.canAcknowledgeDeviations` is pinned against it in `PlanPermissionsTest` |

- **The team-manager grant is checked in the database on every request, by its own predicate.** `TeamService.isActiveManager` asks for an ACTIVE team whose manager is an ACTIVE person with `people.user_id` = the caller AND an ACTIVE user, so assigning or clearing a manager takes effect on the very next request. Its ADMIN short-circuit rides the verified JWT roles.
- A route that merely SHAPES its answer by the grant asks `isActiveManager` the same way, after the ADMIN short-circuit; the view `ETag` hashes the caller's user id, so it carries the verdict (`security.md` "Caching").
- Under a lock it is re-run through `TeamService.lockedIsActiveManager` (`FOR SHARE OF teams, people`): the milestone schedule PUT re-runs it inside the plan lock, so a manager change commits first (403) or waits; the capacity writes re-run it under the TEAM row lock.
- **Ownership cascades down** (work stream → program → project): an owner at ANY level of a node's chain acts on the node. The caller's person is resolved once per request (`PersonService.activePersonIdOf`, not looked up for an ADMIN).

## Exceptions and the problem mapping

- `UnauthorizedException` (→ 401), `ForbiddenException` (→ 403), `NotFoundException` (→ 404), `ConflictException` (→ 409; it may carry an RFC 7807 extension member as data, `cycle`, the `ProblemCycleNode` list of the dependency-cycle problem) and `TooManyRequestsException` (→ 429) live in `authz/Exceptions.kt` and are mapped in `plugins/ErrorHandling.kt`. The last-admin `409` and the self-delete `403` are "Users".
- **All error bodies are RFC 7807 `application/problem+json`** (API-ERR-001/002): `ProblemDetail{type,title,status,detail,instance}`, `instance` defaulting to the request path without query parameters. Emit them through `ApplicationCall.respondProblem(status, detail)` (an explicit `TextContent`, so ContentNegotiation does not relabel the media type as `application/json`).
- `StatusPages` routes `BadRequestException` → 400, **with fixed vocabulary for converter failures**: a `ContentConvertException` anywhere in the cause chain (ContentNegotiation's malformed-JSON wrap, whose raw message carries the target FQCN) answers "Request body is invalid or does not match the expected schema", the Resources decode wrap "Path or query parameter is malformed"; our validators' own messages pass through.
- `CannotTransformContentToTypeException` → 400 when Content-Type is absent, otherwise 415 for an unsupported request media type.
- **The route 404 convention:** read preambles and zero-row mutation results `throw NotFoundException("<Resource> not found")`, never a hand-rolled `respondProblem(NotFound, …)` + return.
- **Unique-violation `23505` → 409** (`about:blank`), except the two people indexes: `uq_people_email_active` answers `urn:astrolabe:problem:person-email-taken` and `uq_people_user_id_active` `urn:astrolabe:problem:person-login-taken` (`UNIQUE_CONSTRAINT_TYPES`); the `detail` is the index's own sentence either way. NUL-byte `22021` → 400.
- A statement the database cancelled at its time limit (`57014`, anywhere in the cause chain, also through the catch-all and the access check's failed read; `StatementTimeoutAnswerTest`) → 500 with `type: urn:astrolabe:problem:database-timeout` and one WARN (`persistence.md`, `observability.md`). A catch-all `Throwable` → 500 (logged) through the same helper.
- A `status(TooManyRequests)` handler gives the `RateLimit` plugin's bodiless 429 (per-IP buckets, and the six per-USER buckets `telemetry`, `jira-bind`, `jira-import`, `password-change`, `sync-run` and `schedule-proposal-save`) a generic problem body and emits the `rate_limit.exceeded` audit event (coalesced per bucket per minute with a `suppressed` count; `observability.md`).
- **That handler rewrites any non-StatusPages 429**, which is why caller-specific 429s (the login lockout) must go through `TooManyRequestsException` (handled calls are marked and skipped).
- A sibling `status(MethodNotAllowed)` handler gives routing's bodiless wrong-method 405 a problem body (no `Allow` header).
- The SPA fallback (`plugins/Routing.kt`, only when `web.staticDir` is set) never answers under `/api`: an interceptor on its route node throws `NotFoundException`, so an unknown API path is the standard 404 problem body, never index.html (a wrong method on a declared `/api` path is then a 404 too, not 405). `ServerTest` covers it WITH a `staticDir`, through the default client.
- A pre-routing intercept in `configureErrorHandling` 400s any `/api/` path with a negative-integer segment (kotlinx would WRAP `/users/-1` to 4294967295 instead of failing as the spec's `minimum: 0` promises). The JWT `challenge` in `plugins/Security.kt` also calls `respondProblem` (it runs outside `StatusPages`).
- **Audit on denial:** every 403 emits `authz.denied` (method/path/byUserId/detail) from the `ForbiddenException` handler, so route code gets it for free by throwing ("Audit trail" in `observability.md`).

## Routes

One `###` a family; paths are under `/api/v1`. Each table gives the operation, who may call it and the order of its answers (`?:` = "missing is"). Every 403 is the central `authz.denied`; a read writes no audit event (the one exception: an answered rooted Jira import preview audits `jira.import_previewed`).

### Users

| Operation | Who | Order |
|---|---|---|
| `GET /users`, `POST /users`, `PUT`/`DELETE /users/{id}` | ADMIN only (the list included; regular users keep only the self password change) | `requireAdmin` first |
| `GET /users/{id}` | the target user or ADMIN (`requireSelfOrAdmin`) | **guard-before-read**: an unauthorized caller 403s uniformly whether or not the id exists |
| `PUT /users/{id}/features` | ADMIN; self allowed | `requireAdmin` first; unknown feature name 400 (enum decode, before the lookup) → unknown or soft-deleted target 404; wholesale replace, idempotent (same-set re-PUT is 204); audited `user.features_changed` only on a change |
| `PUT /users/{id}/permissions` | ADMIN; self allowed | `requireAdmin` BEFORE the body (a non-admin's probe, unknown id and malformed body are a uniform 403); unknown permission 400 (enum decode, before the lookup) → unknown target 404; wholesale replace of the GRANTED set, idempotent (a same-set re-PUT is 204 and audits nothing; `[]` revokes everything); audited `user.permissions_changed` only on a change |
| `PUT /users/{id}/language` | the target user or ADMIN (`requireSelfOrAdmin`) | unsupported code 400 after the guard (403 wins); idempotent; audited `user.language_changed` on an actual change |
| `PUT /users/{id}/password` | the target user or ADMIN (`requireSelfOrAdmin`) | `429` per-USER `password-change` bucket (10/min, keyed by the CALLER, on the route node) → `403` guard → `429` locked or untrackable (keyed by the PATH id, before `call.receive`) → `400` body decode → `400` new password's rules → `403` wrong or missing `currentPassword` → write |

- **Two protections with a deliberate 403/409 split.** Self-delete is a `ForbiddenException` (403), a permissions-shaped rule about WHO acts. Deleting or demoting the LAST active administrator is a `ConflictException` (409, `urn:astrolabe:problem:last-admin`, `LAST_ADMIN_PROBLEM`), a state-shaped rule about what the system can afford to lose. Over HTTP the caller of `DELETE /users/{id}` is always an active admin, so the last-admin `409` is reachable only as a race (the caller deleted between the access check and the locked admin count); the self-delete `403` is the HTTP answer.
- `POST /users` with `alsoCreatePerson: true` (the SPA's default) also creates the login's person (name, email, linked through `people.user_id`) in the SAME transaction via `PersonService.create`, under the SAME `requireAdmin` (no new guard, nothing a non-admin can reach). A people-side clash (an active person with that email, `409`) fails the whole request and creates no login.
- **Features.** Self is allowed (an admin adjusting their own flags is a feature, and the users routes are never gated, so a fully self-disabled admin can always get back). Mind the wholesale replace: a disabled set omitting MFA, including the empty "re-enable everything" array, ENABLES the second factor.
- **Permissions** take effect on the target's next request ("Roles vs permissions"); `UserResponse.permissions` carries the set on `GET /users/{id}` and the list.
- **Password.** The length rules are `security.md`'s ("Payload validation"), a `400`. A **self-change** (even by an admin) additionally requires a correct `currentPassword` (else `403`, audited `password.change_denied`); an admin resetting ANOTHER user's password does not. A non-self caller never reaches the lock throttle (the guard is first), so a stranger cannot probe an account's lock state (`security.md` "Self password change throttle").
- **Why new-password rules come first:** otherwise `{currentPassword: <guess>, password: <too short>}` would answer 400 on a right guess and 403 on a wrong one, a silent oracle that neither counts, audits nor bumps a revision; refused first, the 400 costs no bcrypt and touches no counter.
- **Existence:** the guard comes first (`requireSelfOrAdmin` needs no read), then a zero-row update maps to 404, safe because the only callers past the guard are the target and admins.
- A successful change stamps `users.password_changed_at` and atomically increments `users.credential_revision` ("Tokens and sessions"); the token a self-change was made with is a `401` on the next request (the SPA signs out explicitly).

Pinned by: `UserRoutesTest`, `UserCreatePersonTest`, `FeatureFlagsTest`, `UserPermissionsTest`, `UserLanguageTest`, `PasswordChangeTest`, `StaleAccessTokenTest`, `GuardsTest`, `AuditTest`.

### People

| Operation | Who | Order |
|---|---|---|
| `GET /people`, `GET /people/{id}` | any authenticated user, emails included (the owner and manager pickers and the People page read it; non-admin stream and program owners pick owners for the nodes they create) | |
| `POST /people`, `PUT`/`DELETE /people/{id}` | ADMIN only | `requireAdmin` BEFORE the body and the id lookup (guard-before-read, the teams rule: a non-admin's probe and malformed body are a uniform 403) |

- The email is optional and unique among ACTIVE people (case-insensitive, `409`); names are not unique. The optional `userId` links a login: an ACTIVE user (`400` otherwise) not linked to another active person (`409`). Only an ADMIN sets it (a login link is a rights path: the person's owner rights ride it), and a change of the link is audited on its own (`person.link_changed`).
- `PersonResponse` resolves `userId`/`userEmail` through ACTIVE users (null for a soft-deleted login: the link stays inert, never an access grant. The caller's person is `people.user_id = caller AND people.active()`, and a deleted login never passes the per-request access verdict).
- Delete is `409` while the person manages an ACTIVE team or owns an ACTIVE work stream, program or project ("Person is still an owner or a team manager").

Pinned by: `PersonTest`.

### Teams and capacity periods

| Operation | Who | Order |
|---|---|---|
| `GET /teams`, `GET /teams/{id}` | any authenticated user (teams are the ownership unit the planning features point at) | |
| `POST /teams`, `PUT`/`DELETE /teams/{id}` | ADMIN only | `requireAdmin` BEFORE the body and the id lookup (guard-before-read: a non-admin's malformed body stays 403); name clash 409; delete 409 while an ACTIVE milestone names the team |
| `GET /teams/{id}/capacity`, `GET /capacity-periods/{id}` | any authenticated user | 404 when the team (or the period, or its team) is deleted |
| `POST /teams/{id}/capacity` | the team's ACTIVE manager or ADMIN | team active ?: 404 → `requireTeamManagerOrAdmin` → body 400 (date shape or year, `mdPerWeek` range and decimals, `wipLimit` outside 1..99) → (in the transaction) team locked, gone 404 → the guard again 403 → insert (409 on the partial index); 201 + `Location` |
| `PUT /capacity-periods/{id}` | the period's team manager or ADMIN | the period's team ?: 404 → the guard on THAT team → body 400 → (locked) re-read 404 → the guard again 403 → replace (409 on a date clash) → 204 |
| `DELETE /capacity-periods/{id}` | the same | the same → 204 |

- **Teams.** A case-insensitive name clash with an active team is `409` (the V6 partial index). The optional `managerPersonId` (create and the full-replace PUT; omitted = no manager) must be an ACTIVE person of the people directory, else `400` ("Unknown or deleted manager ids").
- The manager is a person (`teams.manager_person_id`; the manager's login is `people.user_id`); `managerName` is null for a soft-deleted one. Mutations audit `team.created/updated/deleted` and `team.manager_changed` (only on an actual change).
- **Being a team's manager grants NO write on the team record** (still ADMIN only). The manager's rights are the team-scoped ones: milestone scheduling, the team's capacity periods, the team milestone order, through `requireTeamManagerOrAdmin`. A team delete cascades the team's ACTIVE periods after the milestone 409.
- **Capacity periods are team data** (`teams/TeamCapacityRoutes.kt`); the project's owner and every other caller get 403. **Read-before-guard**: a missing or deleted team is `404` for EVERY caller, then the guard, then `call.receive` (a forbidden caller's malformed body stays 403), then validation. The inner guard runs with `TeamService.lockedIsActiveManager` AFTER the team row is locked `FOR NO KEY UPDATE` (a team delete racing it either commits first, 404, or waits). Capacity takes NO plan lock (it is not plan state).

Pinned by: `TeamTest`, `TeamCapacityTest`, `TeamCapacityLifecycleTest`, `GuardsTest`.

### Plan nodes

Work streams, programs, projects (`planning/*Routes.kt`; the matrix is `product.md` "Domain decisions"). ADMIN everything; ownership cascades down; reads are open to every authenticated user.

**Read-before-guard**, the sanctioned idiom: resolve the node's owner chain (`WorkStreamService.chain` …); missing is `404` for EVERY caller; the guard `403`; `call.receive` (a forbidden caller's malformed body stays 403); validate `400`; write under the plan lock (`409` name clash or active children).

The inner guard (`withPlanWrite`) re-resolves the caller's person `FOR SHARE` against a chain re-read under the lock and, for the target window, re-reads the grant in the same transaction (`security.md` "Slow requests").

| Operation | Who | Order |
|---|---|---|
| `GET` any node, `GET /work-streams`, `GET /programs`, `GET /projects`, `GET /milestones` (paged lists) | any authenticated user | 400 paging, sort, repeated `name`; for programs a malformed or repeated `workStreamId`; for milestones a malformed or repeated `scheduled`/`teamId`/`projectId`/`programId`/`workStreamId` |
| `POST /work-streams` | ADMIN | `requireAdmin` first (it addresses no node: guard-before-read) |
| `PUT`/`DELETE /work-streams/{id}`, `POST /work-streams/{id}/programs` | the stream's owner or ADMIN | chain(stream) ?: 404 → `requireOwnerOrAdmin` |
| `PUT`/`DELETE /programs/{id}`, `POST /programs/{id}/projects` | the stream's or the program's owner, or ADMIN | chain(program) ?: 404 → `requireOwnerOrAdmin` |
| `PUT`/`DELETE /projects/{id}` | any of the three owners (the project's own included), or ADMIN | chain(project) ?: 404 → `requireOwnerOrAdmin` |
| `POST /programs/{id}/move` | an owner ABOVE the program (the stream's; NOT the program's own owner) AND an owner of the target, or ADMIN | chain(program) ?: 404 → `requireAncestorOwnerOrAdmin` → body 400 → target stream chain ?: **400** "Unknown or deleted work stream ids: N" (a body field, never a 404) → `requireOwnerOrAdmin` on the TARGET chain |
| `POST /projects/{id}/move` | an owner ABOVE the project (the program's or stream's; NOT the project's own owner) AND an owner of the target, or ADMIN | chain(project) ?: 404 → `requireAncestorOwnerOrAdmin` → body 400 → target program chain ?: **400** "Unknown or deleted program ids: N" → `requireOwnerOrAdmin` on the TARGET chain; 409 name clash in the target program |
| `PUT /projects/{id}/target-window` | ADMIN, the stream's or program's owner, or `ROADMAP_EDITOR`; NOT the project's own owner alone | chain(project) ?: 404 → `requireTargetWindowEditorOrAdmin` |
| `PUT /projects/{id}/details` | both field and target-window edit permissions | chain(project) ?: 404 → both guards → body; both guards run again against the original chain under the plan lock |

- **A move needs both sides:** the right to take the node out of where it is AND the right to create one where it goes. The source side is `requireAncestorOwnerOrAdmin`: the node's own owner alone may NOT move it (a hand-over cannot dodge the parent's say). The target side is `requireOwnerOrAdmin` on the candidate parent's chain.
- Both run outside for the ordering (source before the body, target after it) and again INSIDE `withPlanWrite`, each against its chain re-read there (`MoveGuards`, one `FOR SHARE` lookup of the caller's person; the source missing is 404, the target missing is 400, nothing written). The ownership arithmetic afterwards reads the NEW chain.
- The plan view carries the source half as `can.move` (`PlanPermissions.canMove`); the target half is the candidate's `can.createProject` / `can.createProgram` (`PlanMoveTest` pins the conjunction against the real moves).
- The owner of a node is a field of its full-replace PUT, so **any caller who may edit a node may reassign its owner** (the ancestors can always take it back); the new owner must be an ACTIVE person (`400` "Unknown or deleted owner ids"). Creating a project may carry the target window (creators are always window editors). A closed work stream (end date) does not block new children.

Pinned by: `PlanStructureTest`, `PlanMoveTest`, `PlanViewTest`, `PlanPermissionsTest`.

### Milestones

A milestone has no owner. Its **plan fields** (name, description, team, estimate) are written by the owner chain of its PROJECT (any of the three, the project's own owner included) or ADMIN; its **dates** only by the manager of its team or ADMIN. A project owner who is not that manager gets 403 on the schedule PUT, and a team manager who owns nothing on the chain gets 403 on every plan-field write. Reads are open. Read-before-guard; the schedule PUT's inner guard uses the milestone's STORED team with the manager re-looked up `FOR SHARE OF teams, people`.

| Operation | Who | Order |
|---|---|---|
| `GET /milestones/{id}` | any authenticated user | 404 when the milestone or any ancestor is gone |
| `POST /projects/{id}/milestones` | the project chain's owners or ADMIN | chain(project) ?: 404 → `requireOwnerOrAdmin` → body 400 (inactive team, estimate, name), 409 name in project; 201 + `Location` |
| `PUT`/`DELETE /milestones/{id}` | the project chain's owners or ADMIN | `milestoneChain` ?: 404 → `requireOwnerOrAdmin(chain.owners)`; delete cascades the links at it |
| `PUT /milestones/{id}/schedule` | the milestone's team's ACTIVE manager or ADMIN | `milestoneChain` ?: 404 → `requireTeamManagerOrAdmin(caller, chain.teamId, teams::isActiveManager)` → body 400 (a negative `expectedRevision` included) → (under the lock) chain re-read 404 → the guard again with `lockedIsActiveManager` 403 → 409 stale (below the milestone's own revision or above the plan's) |
| `PUT /milestones/{id}/pin` | the same as the schedule PUT | `milestoneChain` ?: 404 → `requireTeamManagerOrAdmin`, the schedule PUT's guard, no new flag (`can.schedule` governs it) → body 400 (`pinned` required) → (under the lock) re-read 404 → the guard again 403 → 409 `urn:astrolabe:problem:milestone-unscheduled` when pinning a milestone without dates → 200 `{revision}` (no `expectedRevision`: an idempotent flag) |

- The schedule PUT compares the milestone's `schedule_revision` (409 stale-revision only AFTER the guard: a manager revoked meanwhile is a 403, not a 409).
- **The pin is a scheduling intent, so it has the dates' audience and no flag of its own** (the "three names, one arithmetic" rule is for rights that may split; this one IS scheduling): a project owner who may not set the dates may not freeze them. A manager cleared, a milestone moved to another team or unscheduled while the request was held at the lock are judged on what is stored under it.
- **The `can` flags** (arithmetic: `planning-model.md` "The project view"): a milestone's `can.schedule` is `canSchedule(actor, milestone.teamId)`, so a project owner sees `schedule: false` unless they also manage its team and a team manager `edit`/`delete: false` unless they also own something on the chain. The actor's `managedTeamIds` is looked up once per request for a non-admin (`TeamService.activeManagedTeamIds`; never a token claim) and is empty for an ADMIN.

Pinned by: `MilestoneTest`, `MilestoneScheduleTest`, `MilestonePinTest`, `PlanPermissionsTest`, `ProjectViewTest`.

### Dependencies

**The SUCCESSOR's project chain is the guard.** A link is a plan field of its successor (the constrained side), so it is written by an owner on the SUCCESSOR's project chain (the project's own owner included) or ADMIN. The PREDECESSOR's owner is asked nothing (a link never moves a date) and may neither create, edit nor delete a link another project depends on; a team manager as such has no say.

**The one exception, the cascade:** deleting an endpoint (a milestone, or a project with its milestones) soft-deletes every link at it, whichever side owns them: the endpoint's own guard authorizes that, and the successor's owner is not asked (audited as the delete's `dependencyIds`, `observability.md`). Reads are open to every authenticated user; read-before-guard throughout; the guard runs twice (inside against the chain re-read there with the caller's person `FOR SHARE`).

| Operation | Who | Order |
|---|---|---|
| `POST /projects/{id}/dependencies` | the successor project's chain owners or ADMIN | chain(project) ?: 404 → `requireOwnerOrAdmin` → body 400 (type/kind decode, lag range, self-link) → (under the lock) chain re-read 404 → the guard again 403 → successor must be the project or one of its active milestones 400 → predecessor active 400 → **409 cycle** (`urn:astrolabe:problem:dependency-cycle`, `cycle` as data) → insert (**409** duplicate ordered pair); 201 + `Location` |
| `GET /dependencies/{id}` | any authenticated user | 404 when the link or either end's chain is gone |
| `PUT /dependencies/{id}` | the same | `dependencyChain` (the successor's project chain) ?: 404 → `requireOwnerOrAdmin` → body 400 (decode, lag range) → (under the lock) chain re-read 404 → the guard again 403 → a changed type: **409 cycle** on the graph without this link's old edge → update; 204 |
| `DELETE /dependencies/{id}` | the same | `dependencyChain` ?: 404 → `requireOwnerOrAdmin` → (under the lock) chain re-read 404 → the guard again 403 → 204 |

- **The `can` flags** (arithmetic: `planning-model.md` "The project view's dependencies"): `can.edit` and `can.delete` are `canManage` on the chain of the project that holds the link's SUCCESSOR, so the predecessor's project owner sees `delete: false` on the link into someone else's project.
- **`createDependency`** is the same `canManage` on the project as SUCCESSOR's project, on the project view and (1.27) on each plan-view project; the Dependencies page offers only such projects as the successor's.

Pinned by: `DependencyTest`, `DependencyUpdateTest`, `PlanPermissionsTest`, `ProjectViewDependenciesTest`, `PlanViewTest`.

### Ranking, team order and schedules

| Operation | Who | Order |
|---|---|---|
| `PUT /roadmap/ranking` | ADMIN or `ROADMAP_EDITOR`, nobody else (an owner of any node included) | `requireRoadmapEditorOrAdmin` FIRST, **guard-before-read** (the route addresses no node, so there is no 404 to order against) → body 400 → (under `withPlanWrite`) the grant again 403 → `409` stale-revision and the `400` id errors, after the guard |
| `PUT /teams/{id}/milestone-order` | the team's ACTIVE manager or ADMIN | team active ?: 404 → `requireTeamManagerOrAdmin` → body 400 (negative `expectedRevision`, more than 1000 ids, an id twice) → (under the plan lock) team re-read 404 → the guard again 403 → **409 stale** (`stale-revision`, against the TEAM's own order revision) → ids active and of this team 400 → rewrite → 200 `{revision}` |
| `PUT /work-stream-order` | ADMIN only | `requireAdmin` FIRST, **guard-before-read** (no node is addressed; a forbidden caller's malformed body stays 403) → body 400 → (under the plan lock) **409 stale** (`stale-revision`, the work stream ORDER's own revision) → ids active work streams 400 → rewrite → 200 `{revision}`; no second guard |
| `PUT /work-streams/{id}/program-order` | the work stream's owner or ADMIN (a program's or project's owner gets 403) | stream active ?: 404 → `requireOwnerOrAdmin` → body 400 → (under the plan lock) chain re-read 404 → the guard again 403 (`PlanRouteDeps.ownerGuard`) → **409 stale** (THIS stream's program order revision) → ids active programs OF this stream 400 → rewrite → 200 `{revision}` |
| `POST /teams/{id}/milestone-schedules` | the team's ACTIVE manager or ADMIN | team active ?: 404 → `requireTeamManagerOrAdmin` → whole-batch 400 before the lock (negative `expectedRevision`, malformed `scopeHash`, no items, over 1000, an id twice, an item failing `validateSchedule`) → (under the plan lock) team re-read + `FOR SHARE` 404 → the guard again 403 → **409 whole batch** (`stale-revision`, then with a `scopeHash` `stale-scope`) → per item in body order the first of `GONE` / `NOT_ON_TEAM` / `NO_WORKING_DAY` / `STALE` skips it → 200 `{revision, accepted, skipped}` |

- **The ranking PUT** reads the grant from the database per request, never a claim. `can.editRank` = `PlanPermissions.canEditRank`, pinned against the guard by `PlanPermissionsTest` and the real PUT by `RoadmapRankingTest`.
- **The team order PUT** resolves the team through `PlanRouteDeps.requireTeamManager` and re-guards under the lock with `PlanRouteDeps.teamManagerGuard` (`TeamService.lockedIsActiveManager`, `persistence.md`); the project's owner gets 403.
- **The batch schedule** (`planning/TeamScheduleRoutes.kt`, `TeamScheduleService.kt`) accepts an auto-proposal: N schedule PUTs in ONE plan write under the TEAM's guard, the order PUT's verbatim, run twice (the statuses: `planning-model.md` "The batch schedule", `scheduling.md` "The scope check"). It never widens the single PUT's right: only milestones OF THE TEAM in the path are writable, re-read under the lock (`NOT_ON_TEAM` otherwise).
- **`can.schedule`, `editCapacity` and `editOrder` of the team view** are ONE arithmetic under three names (`planning-model.md` "The team view"): never the project's owner as such. `can.schedule` is also the batch's and the proposal's flag (no fourth flag).

Pinned by: `RoadmapRankingTest`, `TeamOrderTest`, `TeamOrderLifecycleTest`, `PlanOrderTest`, `PlanOrderLifecycleTest`, `TeamScheduleBatchTest`, `TeamViewTest`, `PlanPermissionsTest`.

### Schedule proposals

The run, accept, check and save are computations or writes over a team SET; ADMIN, or the ACTIVE manager of EVERY listed team. A manager of ONE of the teams runs that team alone (`PlanPermissions.canSchedule` over each member; `PlanPermissionsTest` pins the set guard against the flags), never the pair; the project's owner and every other caller get 403.

| Operation | Who | Order |
|---|---|---|
| `POST /teams/{id}/schedule-proposal` | the team's ACTIVE manager or ADMIN | team active ?: 404 → `requireTeamManagerOrAdmin` 403 → body (a forbidden caller's malformed body stays 403) → `asOf` 400 (`parseIsoDate`) → one read-only snapshot → 200 `ScheduleProposal`. A COMPUTATION: nothing stored, no plan lock, no bump, no audit, the guard run ONCE |
| `POST /schedule-proposals` | ADMIN or the manager of every listed team | body decodes ?: 400 → `teamIds` shape 400 (1..50, none twice) → every team active ?: 404 (the detail names the ids, one `TeamService.activeNamesAmong` query) → `requireTeamManagerOfAllOrAdmin` 403 → `asOf` 400 → one read-only snapshot (a team deleted in the gap is the same 404) → 200 `CrossTeamProposal`. A computation, one outer guard |
| `GET /schedule-proposals/teams` | any authenticated user | 200 `{items[{id, name}], truncated}`: up to 1,000 teams `canSchedule` allows (ADMIN all, a manager exactly their own, a manager of nothing none) |
| `POST /schedule-proposals/accept` | ADMIN or the manager of every listed team | body decodes ?: 400 (a missing `scopeHash` included) → `teamIds` shape 400 → every team active ?: 404 → `requireTeamManagerOfAllOrAdmin` 403 → the rest of the shape 400 before the lock → (under the plan lock, teams ascending) per team `lockActiveTeam` 404 + the locked guard 403 → **409 whole request** (`stale-revision`, then `stale-scope`) → per item in body order the first of `GONE` / `NOT_ON_TEAM` / `NO_WORKING_DAY` / `STALE` skips it → 200 `{revision, accepted, skipped}` |
| `POST /schedule-proposals/check` | ADMIN or the manager of every listed team | body decodes ?: 400 → `teamIds` shape 400 (1..50, none twice) → every team active ?: 404 (names the ids) → `requireTeamManagerOfAllOrAdmin` 403 → the items' shape 400 (1..2000, an id twice, an item failing `validateSchedule`) → one read-only snapshot → a milestone outside the listed teams 400 → 200 `{teams[{teamId, weeks, weeksTruncated, dependencies}]}` |
| `POST /saved-schedule-proposals` | ADMIN or the manager of every listed team | per-USER `schedule-proposal-save` bucket 429 → body decodes ?: 400 → `teamIds` shape 400 → every team active ?: 404 → `requireTeamManagerOfAllOrAdmin` 403 → the rest of the shape 400 (name, `asOf`, revision, hash, ticks) → one transaction, no plan lock, after its table lock the guard again 403 → **409** (`stale-revision`, then `stale-scope`) → a ticked id that is no move 400 → 201 summary |
| `GET /saved-schedule-proposals`, `GET /saved-schedule-proposals/{id}` | any authenticated user | the list `{items}` (at most 20); the record ?: 404, with `can.delete` and `can.accept` for the caller |
| `DELETE /saved-schedule-proposals/{id}` | ADMIN or the manager of every STORED team | **read-before-guard** (the stored teams are the guard's input): row ?: 404 for every caller → `requireTeamManagerOfAllOrAdmin` over the stored teams 403 → hard delete 204 |

- **The team SET is in the body, which changes the order** (`planning/CrossTeamScheduleRoutes.kt`, `CrossTeamProposalService.kt`): the body decodes FIRST (a malformed body is `400` even for a caller who would be refused: there is no team to guard before it is read), then the ids' shape, then the existence `404` for every caller, then the set guard.
- `requireTeamManagerOfAllOrAdmin` is DB-free: ADMIN short-circuits, otherwise ONE `TeamService.activeManagedTeamIds` lookup and every listed team must be in it; the first miss fails the whole set with the single-team guard's words.
- The accept's "rest of the shape" 400 is the negative `expectedRevision`, a `scopeHash` not 64 lowercase hex, no items, more than 2000, an id twice, an item failing `validateSchedule`. `stale-revision` is `expectedRevision` above the plan revision; `stale-scope` is the run's fingerprint with the CURRENT team names differing, or a milestone of a run team outside the items scheduled after `expectedRevision`.
- A forbidden caller's malformed `asOf` or items stay `403`, and an item naming a milestone outside the listed teams is a `400` only for a caller who passed the guard (no existence disclosure to a stranger).
- **The accept's inner half runs per team, never once for the set** (`TeamScheduleService.acceptRun`): ascending id, `lockActiveTeam` (404 if the team went away meanwhile, even for ADMIN) and the locked guard `teamManagerGuard` (403 if the caller stopped managing ANY team of the set), so a manager cleared from the second team while the request waited is a 403 with nothing written and no bump. An item whose STORED team is outside the set is `NOT_ON_TEAM`, so the rows written are exactly those of the teams the caller was just verified to manage.
- **The save re-runs the guard inside its transaction** (`SavedProposalService.save`, right after its table lock: one `activeManagedTeamIds` query, a manager cleared while it waited is a 403, nothing stored); it takes no plan lock and writes no plan row. The delete guard stops a TARGETED delete only: ANY save evicts the globally oldest row, whoever saved it (the user's answer), and a stored team since deleted is not managed, so only ADMIN deletes that proposal.
- **The new disclosure:** every login reads a saved proposal, so a caller who manages none of its teams reads the run's OUTPUT (proposed dates, unplaced reasons, the post-check, the ticks, the saver and when), which `POST /schedule-proposals` refuses them; team names stay as saved until the row is evicted or deleted. Nothing in it is secret (names, dates, load).

Pinned by: `ScheduleProposalTest`, `CrossTeamProposalTest`, `CrossTeamAcceptTest`, `ScheduleCheckTest`, `GuardsTest`, `SavedProposalTest`, `SavedProposalStateTest`.

### Views

Every plan view is a read for any authenticated user: `call.caller()` and nothing else, no audit event, no lock. The caller's rights ride in the `can` flags. A view shaped by the caller (`can`, "Yours") says so in its row below; every other member is the same for every login.

| Operation | Who | Order and notes |
|---|---|---|
| `GET /views/plan` | any authenticated user | the `can:{}` flags of "Plan nodes", `createDependency` ("Dependencies") |
| `GET /views/project/{id}` | any authenticated user | 404 when the project or any ancestor is gone, for every caller; the `can` flags of "Milestones" and "Dependencies" |
| `GET /views/team/{id}` | any authenticated user | 404 when the team is deleted; `team.can.schedule`, `editCapacity`, `editOrder` ("Ranking, team order and schedules"); `criticalChain`: no caller-scoped member |
| `GET /views/roadmap` | any authenticated user | `can.editRank` and each project's `can.editTargetWindow`; `400` for an unknown or deleted `criticalPath` project id (ids are no secret, every login reads the plan) |
| `GET /views/programs` | any authenticated user | project rows carry the roadmap's `can.editTargetWindow`; programs and work streams carry no `can`; no `404`; `?criticalPath=N` is the roadmap's rule (the block names only project ids the same document lists) |
| `GET /views/home` | any authenticated user | `call.caller()` only; no `can`; "Yours" and `me` below |
| `GET /views/team-load` | any authenticated user | `call.caller()` only; no `can`; byte-identical for every login |
| `GET /views/dependencies` | any authenticated user | `call.caller()` only; each row's `can{edit, delete}` is the one caller-scoped member |
| `GET /views/baseline/{id}`, `?baseline=N` on the four timeline views | any authenticated user | "Baselines" |

- **`can.editTargetWindow`** (roadmap and programs project rows) is exactly `requireTargetWindowEditorOrAdmin`'s arithmetic on the chain read in the same statement as the row (the project's own owner alone is not enough); `RoadmapViewTest` checks it against the real `PUT /projects/{id}/target-window` for ADMIN, each owner, an editor, a stranger, a person-less login and a team manager.
- **The Flow capacity flag of the project rows** is the same for every caller: it derives from plan and team data every login reads (the roadmap, the team pages, the Deviations page) and depends on no `can`, no owner chain and no role.
- **The home view is strictly caller-scoped, every figure an existing read's own** (`planning-model.md` "The home view"): the `plan` block is derivable by any login from the roadmap, programs, project and team views and `GET /milestones`; `me` is the caller's own; who owns a node is in `GET /views/plan`, who manages a team in `GET /teams`. A row names its owner (`ownerName`, already in the plan view and the roadmap) and says whether the person is that owner (`direct`). No `403`, `404`, `400` or bucket of its own; no parameter, so no way to another person's Home.
- **"Me" and "Yours" are looked up for an ADMINISTRATOR too** (`HomeCaller(userId)`, resolved inside the view's snapshot; `callerPersonId`'s ADMIN short-circuit is NOT reused): an administrator without a person, or a deleted or unlinked one, gets `me: null`, never "everything". "Yours" is the owner chain, what the guards allow a non-administrator to change (`HomeViewTest` compares it with the `can.edit` flags, caller by caller): it widens a list, never a right, and discloses nothing the Roadmap does not.
- **The team-load view carries nothing caller-scoped:** neither role, person nor grant reaches a query, so the document is byte-identical for every login (`TeamLoadViewTest`: the administrator, the three owners, a stranger, a person-less login, an editor; `currentWeekStart` is the SERVER's). It discloses nothing new: team names and managers are `GET /teams`, milestone counts and weeks `GET /views/team/{id}`, the `warningWeeks` the team view's `weeks[]` and `GET /teams/{id}/capacity`; no person id, email, Jira or Flow member.
- **The dependencies view has exactly one caller-scoped member: each row's `can{edit, delete}`**, `true` exactly when `PUT` / `DELETE /dependencies/{id}` would answer `204` for that caller (`DependencyListViewTest`; arithmetic: "Dependencies"). Without `can` the document is identical for every login and the owner chain (person ids) never leaves the kernel.
- It discloses nothing new (every link with both ends resolved is in the project and team views, `GET /dependencies/{id}` is open): no owner, person id, email, document-level `can` or Jira or Flow member; a deleted link, or one of a deleted milestone or project, is in no row and no total.
- **View validators** (ten view GETs; `security.md` "Caching"). `If-None-Match` is evaluated strictly AFTER `call.caller()`, the parameters and the view's own `404`/`400`: a request without a valid token is a `401` whatever the header says, a refused or unknown one never a `304` and never tagged. The tag hashes the caller's user id and the rendered document, so a `304` discloses only "the document you already hold is still yours" and one login's tag matches nothing of another's (`ViewValidatorsTest`).
- **The Jira links and flags in the timeline views** add no guard (every authenticated caller). `jira`, the Jira `flags` and `jiraSites[]` (`connectionId`, `siteUrl`, `state`, `mappingOk`) ride the four views' existing rows; the disclosure class is `GET /views/deviations`' (the binding, issue key, observed data, deviation details and site host are readable by every login there and through `GET /bindings`).
- The per-row `jira` member carries `bindingId`, `connectionId`, `issueKey` and the observed dates, never the connection's name, token, project keys or mapping; a site's JSON has exactly its four keys, never the `lastRun`, an error code or the mapping (`TimelineJiraFlagsTest`). A DISABLED connection's rows keep `jira` and their `jiraSites[]` entry with null dates and no flag. No `can` is added: acknowledging is guarded where it was.

Pinned by: `PlanViewTest`, `ProjectViewTest`, `TeamViewTest`, `RoadmapViewTest`, `HomeViewTest`, `TeamLoadViewTest`, `DependencyListViewTest`, `ViewValidatorsTest`, `TimelineJiraFlagsTest`, `PlanPermissionsTest`.

### Public holidays

`planning/PublicHolidayRoutes.kt`. **Written by ADMIN only, guard-before-read** (the `teams/` registry shape, not the plan nodes' read-before-guard: a flat ADMIN registry with no owner chain, so a non-admin probe learns nothing about which ids exist). The writes are plan writes (`withPlanWrite`) but the plan lock is not an authorization: there is no inner re-guard, as for the other ADMIN-only registries (`teams/`, `people/`).

| Operation | Who | Order |
|---|---|---|
| `GET /public-holidays` | any authenticated user | |
| `POST /public-holidays` | ADMIN | `requireAdmin` 403 → body 400 (ISO date 1900-2999, name 1..100 single-line) → insert (409 `uq_public_holidays_date`) → 201 + `Location` |
| `POST /public-holidays/apply-preset` | ADMIN | `requireAdmin` 403 → body 400 (unknown preset, year outside 1900..2999) → insert the missing dates → 200 `{added, skipped}` |
| `DELETE /public-holidays/{id}` | ADMIN | `requireAdmin` 403 → (under the plan lock) row gone 404 → 204 |

Pinned by: `PublicHolidayTest`, `HolidayPresetTest`.

### Baselines

`planning/BaselineRoutes.kt`. **Written by ADMIN or a `ROADMAP_EDITOR`, guard-before-read** (the ranking's shape: a baseline is a plan-wide statement with no owner chain, so ownership of any node is irrelevant). `requireRoadmapEditorOrAdmin` runs FIRST on every write, before `call.receive` and before the id lookup, and AGAIN inside `withPlanWrite` after the lock (the grant re-read in the same transaction: a grant revoked while the request waited refuses the write, 403, no bump).
The cap (409 `baseline-limit`) and the name clash (409) come after the inner guard, both under the lock, the cap first.

| Operation | Who | Order |
|---|---|---|
| `GET /baselines`, `GET /baselines/{id}` | any authenticated user | the list answers `{items, can{manage}}` (`canManageBaselines` = `canEditRank`'s arithmetic, pinned by `PlanPermissionsTest` and `BaselineTest`); an unknown or deleted id is 404 |
| `POST /baselines` | ADMIN or `ROADMAP_EDITOR` | `requireRoadmapEditorOrAdmin` 403 → body 400 (name 1..100, description ≤ 500, control characters) → (plan lock) the grant again 403 → cap **409** `urn:astrolabe:problem:baseline-limit` → the copy; name clash **409** (`uq_baselines_name_active`) → 201 + `Location` + `Baseline` |
| `PUT /baselines/{id}` | the same | 403 → body 400 → (lock) the grant again 403 → gone 404 → name clash 409 → 204 |
| `DELETE /baselines/{id}` | the same | 403 → (lock) the grant again 403 → gone 404 → soft delete → 204 |

- **The baseline reads** (no new guard, every authenticated caller). The four timeline views take `?baseline=N` and `GET /views/baseline/{id}` answers the comparison; they carry no `can` of their own.
- **Order:** the view's own rules first (a gone project or team is `404` for every caller before any baseline question), then the parameter: a malformed or repeated `baseline` is a plain `400`; an unknown or soft-deleted id is the `400` `urn:astrolabe:problem:unknown-baseline` (a query value the client held, e.g. the picker's remembered pick; it clears the pick and asks again).
- `GET /views/baseline/{id}` addresses the baseline itself: unknown or soft-deleted is `404`, malformed `400`. Its `?against=N` (the second baseline) is a query value like `?baseline=`: malformed or repeated is a plain `400`, then the path id's `404`, then `against == id` a plain `400`, and an unknown or soft-deleted N the typed `unknown-baseline` `400`.
- **Existence disclosure:** baselines are readable by every signed-in user, so the `400`/`404` on an id reveals nothing new.

Pinned by: `BaselineTest`, `BaselineViewTest`, `ProjectViewBaselineTest`, `TeamViewBaselineTest`, `RoadmapViewBaselineTest`, `ProgramsViewBaselineTest`.

### Telemetry

`telemetry/TelemetryRoutes.kt`. `GET /api/v1/telemetry/current` and `GET /api/v1/telemetry/history?group=&range=` are **ADMIN only, read-only** (operational data: process sizes, container limits, request figures). `requireAdmin(call.caller())` is the first statement, before the query is read, so a non-admin gets the uniform `403` for a bad or missing `group`/`range` too (`403` outranks `400`); only then is an unknown, missing, blank or repeated `group` / `range` a `400`.
No mutation, so no audit event of its own (a denial is the generic `authz.denied`); both ride the per-user `telemetry` bucket (30/min, inside `authenticate`; `security.md` "Telemetry"). Shapes: `observability.md` "Telemetry". Pinned by: `TelemetryRoutesTest`.

### Jira connections, probes, mapping and Peek

`jira/JiraConnectionRoutes.kt`, `JiraTestRoutes.kt`, `JiraMappingRoutes.kt`. **ADMIN only on every operation, reads included, `requireAdmin` FIRST** (before the id lookup and before the body decodes; guard-before-read, the teams rule). A non-admin's probe, unknown id and malformed body are a uniform 403, so the registry (a connection's name, site, email, keys and mapping) is readable by nobody but an ADMIN; the binding routes disclose a little of it to node owners, deliberately.

| Operation | Who | Order |
|---|---|---|
| `GET /integrations/jira/connections`, `POST`, `GET`/`PUT`/`DELETE …/{id}` | ADMIN | `requireAdmin` first; name clash with an active connection 409 (V21 partial index); a `PUT` that changes `siteUrl` is 409 (the site is the identity) |
| `POST …/connections/test` | ADMIN | 403 before the body decodes → sanitize + validate 400 → the probe; per-IP `jira-test` bucket; never 502 |
| `POST …/connections/{id}/test` | ADMIN | 403 whether or not the id exists → 404 unknown or deleted → the probe with the stored token; per-IP `jira-test` bucket; never 502 |
| `GET …/connections/{id}/discovery` | ADMIN | the stored field and issue-type snapshot; 404 unknown; `409 urn:astrolabe:problem:jira-not-discovered` before a stored test has stored a snapshot (`field` and `issuetype` both answered) |
| `GET …/connections/{id}/mapping` | ADMIN | 404 unknown; never a 409 on a read; a column this build cannot decode is a problem line, never a 500 |
| `PUT …/connections/{id}/mapping` | ADMIN | 403 before the body → the body's shape rules 400 → 404 unknown or deleted → (inside the service, under the row lock, against the snapshot just read) `409 jira-not-discovered`, then the discovery-dependent rules 400 → 204 |
| `GET …/connections/{id}/peek?key=ABC-12` | ADMIN | 403 → the key's shape (a repeated `key` too) 400 → 404 unknown connection → see below; per-IP `jira-test` bucket |
| `GET …/connections/{id}/coverage` | ADMIN | 403 whether or not the id exists → 404 unknown or deleted; per-level COUNTS over the census mirror (`NOT_SYNCED` or `MAPPING_UNUSABLE` without counts), never a key, a name or a summary; a read, no audit |

- **Token.** Write-only (Rules; `hasApiToken` says one is stored); an update that omits it keeps the stored one. Mutations audit `jira.connection_created/updated/deleted`; a test `jira.connection_tested`; a mapping change `jira.mapping_changed`.
- **Tests never answer 502:** an upstream failure, a missing scope and an undecryptable stored token are rows in a `200`; the per-IP `jira-test` bucket is 10/min by default.
- **The mapping GET** returns the stored document, the discovery's `defaults`, the `effective` one and the `problems` of the stored document against the current discovery (reported, never rewritten). The discovery, not a passing test, is what counts for the PUT's 409.
- **Peek after the key's shape:** a key whose project is not one of the connection's keys 400 → 409 before a discovery, or `urn:astrolabe:problem:jira-token-unreadable` for a stored token that cannot be decrypted → the Jira call: a key Jira does not know 404, an upstream failure `502 urn:astrolabe:problem:jira-upstream` whose detail is the failure code only; a moved issue is judged by the key Jira returns. Peek returns the system fields and the MAPPED fields' values as sent, never any other member of the issue document, and stores and audits nothing.

Pinned by: `JiraConnectionTest`, `JiraTestConnectionTest`, `JiraMappingTest`, `JiraCoverageTest`, `AnonymousAccessTest`.

### Jira bindings and acknowledge

`jira/JiraBindingRoutes.kt`, `JiraAcknowledgeRoutes.kt`, `JiraAcknowledgeService.kt`. **Reads any authenticated user's** (the node names are already public to every reader of the plan; a row carries the connection's ID and the issue's browse URL, never the connection's name, email or token). **Writes the owner chain of the node or ADMIN, read-before-guard** (ids are sequential and every signed-in user reads the plan).

`requireOwnerOrAdmin` guards the bind and the unbind, so a team manager as such, a `ROADMAP_EDITOR`, a person-less login and a stranger are 403 (the acknowledge adds a milestone's team manager). The arithmetic is the node's own chain: a program, the stream's and the program's owner; a project or a milestone, the stream's, the program's and the project's owner (a milestone has no owner of its own).

| Operation | Who | Order |
|---|---|---|
| `GET /integrations/jira/bindings`, `GET …/{id}` | any authenticated user | 400 paging, sort, repeated or malformed `connectionId`/`level`/`q`; `GET {id}` 404 for an unknown or unbound binding or one whose node (or any ancestor) is gone |
| `POST /integrations/jira/bindings` | the node's owner chain or ADMIN | body first (**the documented exception**), then node chain 404 → `requireOwnerOrAdmin` 403 → …; "The bind in order" |
| `DELETE /integrations/jira/bindings/{id}` | the owner chain the node HAD, or ADMIN | the binding ACTIVE ?: 404 for every caller → `requireOwnerOrAdmin` on the **last-known chain** → (in the transaction, the row locked) re-read 404 → the guard again 403 → soft delete → 204 |
| `POST …/bindings/{id}/acknowledge` | the owner chain, ADMIN, or (MILESTONE binding only) the ACTIVE manager of the milestone's STORED team (`requireOwnerOrTeamManagerOrAdmin`) | "The acknowledge in order" |
| `DELETE …/bindings/{id}/acknowledge[?kind=]` | the same (`requireOwnerOrTeamManagerOrAdmin`) | "The acknowledge in order" |

**The bind in order.**

1. The body decodes: malformed JSON, an unknown `level` or a missing field is a 400 for every caller (the node is IN the body, so no node is addressed until it decodes).
2. The node's ACTIVE chain ?: 404 for EVERY caller; then `requireOwnerOrAdmin` 403.
3. `issueKey` shape 400; the connection (unknown, deleted or disabled) 400; stored token unreadable or no discovery 409; the stored-or-default mapping against the CURRENT discovery 409 `jira-mapping-invalid`; the level unmapped 400; a key outside the connection's project keys 400.
4. ONE Jira read outside any transaction (unknown issue 400, upstream failure 502); the issue's hierarchy level differing from the mapping's 400.
5. In the transaction (locks in `persistence.md` order): connection and node re-checked (400/404), **the guard again 403** with the caller's person re-resolved `FOR SHARE` against the chain re-read there; 409 `already-bound` (the node's, then the issue's, on this connection or another of the same site) unless the issue's holder's node is gone, which releases it; 201.

**The acknowledge in order.**

1. The binding ACTIVE **and its node's LIVE chain** (the node and every ancestor active) ?: 404 for EVERY caller (a dead-node binding has nothing to acknowledge and is hidden from the view). Unlike the unbind it uses the ACTIVE chain, not the last-known one.
2. `requireOwnerOrTeamManagerOrAdmin` 403, before the body (a forbidden caller's malformed body stays 403).
3. POST: body 400 (`fingerprint` 64 lower-case hex; `kind` optional, a `DeviationKind` name). DELETE: `?kind=` parsed outside the transaction (unknown, blank or repeated 400; **fails closed**: a query parameter of any other NAME, e.g. `kinds` or `kind[]`, is a 400 too, because ignoring it would withdraw every stored acknowledgement).
4. ONE short transaction, no plan lock: the binding row `lockActiveForWrite` (gone 404); the audience (chain and stored team) re-read ACTIVE (404); **the guard again 403** with `lockedActivePersonIdOf` and, for a non-owner on a milestone, `TeamService.lockedIsActiveManager` (team and manager's person `FOR SHARE`); the binding's deviations recomputed IN this transaction.
5. POST: **409 `stale-deviations`** when the list fingerprint differs, the full list is empty or the requested `kind` is not in it; the target kinds' rows of `jira_deviation_acknowledgements` are replaced; 200; audit after the commit. DELETE: nothing stored for it 404 (after the guard, under the lock); delete the row of that kind, or every row of the binding without one; 204.

- **The audience.** The bind's guard plus, on a MILESTONE binding only, the ACTIVE manager of the milestone's STORED team (read with the owner chain by `milestoneChain` and re-read under the binding's row lock, never a request field), who may acknowledge AND withdraw every deviation of it, whoever stamped it. Nothing changes on a program or project binding (a team manager there is 403, as is another team's manager on a milestone), nor for the bind, the unbind or Flow's capacity acknowledge. A roadmap editor, a person-less login and a stranger are 403.
- The binding is in the path, so there is no body-first exception. `409 stale-deviations` is a state rule: after the guard and the body, the ONLY comparison that reads the deviations, checked against the list recomputed inside the write's own transaction for THIS binding. No rate bucket (nothing calls Jira). The audience is per binding, not per line: one `can.acknowledge` on the item, a `kind` does not change who may call.
- **Residual:** the guard's second run reads the milestone's team without locking the milestone row, so a team change committing in between is judged on the old team (one stamp written or withdrawn by the former manager a moment after the move, never plan data).

**The unbind chain rule.** A node can be deleted while its binding stays (a node delete never touches `jira_bindings`; the run's sweep and the next bind of the issue release it), and nobody can act on a deleted node, so the unbind is guarded by the owner chain the node HAD: `lastKnownChain` (`jira/JiraBindingNodes.kt`) reads the three owner columns WITHOUT any `active()` filter, for the guard only (and its second run). ADMIN, or an owner on that stored chain, may unbind; everyone else stays 403. For a live node the last-known chain IS its chain.

A stale mapping answers 409, not 400: the mapping is the connection's state (an ADMIN fixes it), unlike a mapping PUT, which submits the document under test.

#### What a node owner can learn

Anyone who owns any node can reach the bind, bounded by the per-user `jira-bind` bucket (30/min, spent before the guard). They learn that a connection id exists and is enabled (unknown or disabled is a `400`); a connection's project keys, one key at a time (outside them a `400`, inside but unknown to Jira "Unknown Jira issue"); the mapped Jira field ids and hierarchy level (the `409 jira-mapping-invalid` detail quotes the first problem).
They also learn whether an issue exists in the connection's projects, its type name and hierarchy level (the level-mismatch `400` names both) and, for an issue they bind, its summary, status, dates, estimate and Team.

**What any signed-in login sees in `GET /bindings`:** for every live binding its connection id, the issue's key, id and browse URL, the latest observation and who linked it (a name, never an email); never a connection's name, email, token, keys or mapping (`GET /views/deviations` adds the NAME, the project keys and whether the mapping resolves). The issue data a bind shows is data the plan's owners are meant to see about the items they link.

Pinned by: `JiraBindingTest`, `JiraBindingLifecycleTest`, `JiraBindingRaceTest`, `JiraAcknowledgeTest`, `JiraAcknowledgeLinesTest`, `JiraAcknowledgeRaceTest`, `DeviationViewAckTest`, `GuardsTest`, `PlanPermissionsTest`, `AnonymousAccessTest`.

### Jira import

`jira/JiraImportRoutes.kt`, `JiraImportApply.kt`. The first routes of the connections tree a non-admin can reach (the registry itself stays ADMIN-only). What the preview and the apply compute, their shape checks and kernel: `jira-sync.md` "Import".

| Operation | Who | Order |
|---|---|---|
| `POST /integrations/jira/connections/{id}/import-preview` | ADMIN, or an owner of EVERY target the import touches | "The preview in order". A read: nothing stored, no lock, no audit (an ANSWERED rooted preview audits `jira.import_previewed`: `byUserId`, `connectionId`, `rootLevel`, `rootNodeId`, `rows`; ids and a count, no Jira text) |
| `POST /integrations/jira/connections/{id}/import` | ADMIN, or an owner of the target of EVERY ticked CREATE/BIND row | "The apply in order". The one Jira write that moves the plan: one plan revision bump, `jira.import_applied` audit |

The apply's rule is deliberately NOT the preview's: the preview is a 403 when ANY row of the scope targets an unowned node, while an owner may apply the rows they tick onto their own targets even then (each apply is audited and leaves visible rows).

#### The preview in order

1. The per-USER `jira-import` bucket (5/min, shared with the apply, spent BEFORE the guard: `429` whatever the request would have answered).
2. The connection: `404` for an unknown or deleted one, for every caller (**its existence is public** through `GET /views/deviations connections[]`); a state read, **no token decrypt**.
3. The body `400`, decoded after the connection like the bind decodes after its node.
4. The NAMED targets' chains (`404`: `Work stream not found`, `Program not found`, `Project not found`; also the optional `root`'s node), read WITHOUT any guard.
5. `403` for a login that owns no active work stream, program or project (and for a login with no active person); then `requireOwnerOrAdmin` on the chain of each named default (`defaults.programId`, `defaults.projectId`) and of the `root`.
6. **Only now the token is decrypted** (`readForBind`; a refused caller never reaches it, `JiraImportDecryptOrderTest`).
7. The shape `400`s; connection enabled (`400`); token, discovery, mapping (`409`, the bind's resolution); with a root, its ACTIVE link through THIS connection (`409 urn:astrolabe:problem:jira-root-unusable`).
8. The paged browse (`502`, code only; a connection deleted or disabled meanwhile is the `404` / `400` of the per-page stop, never a `500`), the snapshot and the pure kernel; with a root, its own row must read `ALREADY_BOUND` to the root node through this connection, else the same `409`.
9. **The RESOLVED targets' guards**, in row order: the picked work stream when a program row would be created, every EXISTING node a created row lands under, every BIND target. The `403` names the first one the caller does not own; a caller who owns neither the stream, any target nor any node of the stream's tree is refused too, so a preview that only skips rows still proves ownership.
   A caller who owns only nodes of the tree (no target, no named default) gets the rows with the usual redaction. The guard judges the FILTERED row set, so a filter can turn a `403` preview into a `200` over the caller's own targets.

**Deliberate:** the picked work stream is guarded only when a program would be created (an owner of a program may import under their program); the cost is that the browse (outbound calls with the connection's stored token, bounded by the 5/min bucket and a 170 s deadline) runs before the resolved `403`. The caller's right to SCHEDULE never refuses: it sets `canSchedule`/`scheduled` per milestone.

#### The apply in order

1. The `jira-import` bucket (`429` first) → the connection (`404`; a state read, no decrypt) → the body (`400`) → the named targets (`404`; the `root` too) → `403` for a login that owns no plan node, then the guard on each named default and on the root's chain → **only now the token is decrypted** (`readForBind`, as in the preview).
2. The shape `400`s (including every `overrides.teamId` an active team and every `overrides.ownerPersonId`, the per-row owner of a created program or project, an active person, with no guard beyond the dialog-level owner's, which is none) → connection enabled, token, discovery, mapping (`400`/`409`) → with a root, its active link (`409 jira-root-unusable`) → the browse (`502`; **a browse truncated at the 2,000 cap, or at the 200 parent reads of a filtered browse, is a `400` before any write**: a parent cut away reads as an orphan).
3. ONE `withPlanWrite`, where everything is re-read and re-guarded: the connection row `FOR SHARE` (deleted `404`, disabled or out of scope `400`, mapping or discovery changed since the browse `409`, project keys moved `400`); the caller's person `FOR SHARE`; the named defaults' and the root's chains (`404`/`403`); the owner, every `overrides.ownerPersonId` (distinct, ascending) and the named teams active (`400`).
   The caller's managed teams are locked (`lockedIsActiveManager`: a caller who does not manage a milestone's team gets it created unscheduled, never refused); the kernel runs over rows read under the lock (with a root, its own row must still read `ALREADY_BOUND`: else `409 jira-root-unusable`, a rollback).
4. `requireOwnerOrAdmin(caller, lockedPersonOf(caller), chain)` on the chain of EVERY ticked CREATE/BIND row's target (the stream when a program is created, each existing parent, each BIND target; not only the rows that end up written, so a ticked row cannot probe an unowned subtree). A failure, such as an ownership revoked while the request waited for the plan lock, is a `403` that rolls back (nothing written, no bump; audited only as the central `authz.denied`).
5. A created project's target window (from Jira's dates) needs no guard of its own: whoever may create the project is above it in the chain, so `requireTargetWindowEditorOrAdmin` is met by construction.

**What the answer carries.** `created[]`/`bound[]` name only rows written on the caller's own targets; a created row's `name` IS the Jira summary (cut at 100 characters), text the caller may not have seen in a full preview (a 403) but is creating a visible, audited node from. `skipped[]` carries `jiraId`, the issue key and a reason, never a summary, name, team or date. The connection's existence stays public.

#### What a non-admin learns, the rooted import and suggested matches

The mechanics of the redaction, the filter, the root and the matches are `jira-sync.md` "Import"; the rules that bind a change:

- **Redaction.** A SKIPPED row has no target, so no guard looks at it, and a plan-node owner could otherwise read the whole scope's summaries unaudited. So for a non-admin every SKIP row except `ALREADY_BOUND` is blanked (`summary = ""`, `name = issueKey`, `infos = []`; never dates, estimate, team or target; `unmatchedTeams` from the rows that would be created only): `redactForNonAdmin`, pure, applied at the route; ADMIN sees everything. `ALREADY_BOUND` rows keep their text (they name a plan node anyone reads).
- **A filter is a probe the caller steers,** so under an ACTIVE filter (`excludeDone`, `updatedWithinDays`) the blanked rows also lose every per-item handle (`issueKey` null, `jiraId` `hidden-<n>`, no parent ids). **The apply is closed the same way** (`LockedApply.withheldIds`, `skippedAnswer`): a ticked id the SAME-SCOPE preview redacts is dropped before the kernel runs, reaches no guard (no `403` naming its key), is never written, and is answered `CHANGED` with no key, like an id the browse does not hold.
- **Residual, inherent in "ADMIN or an owner of every target":** a row landing on the caller's own target is shown in full and a work stream's owner sees the whole tree under it; a plan-node owner learns that the connection is enabled, discovered and mapped (the `409`s); a login owning no node learns nothing of the site. The counts of redacted rows are visible (a count is a verdict when its group holds one issue: `BACKLOG.md`). All of it is bounded by the `jira-import` bucket.
- **A real disclosure, stated plainly:** an owner who links their node to a Jira item (an audited bind) can then preview the text of everything under that item in the connection's projects. **The rooted preview that is answered is therefore audited,** so a bind, a rooted preview and an unbind leave a trace of what was read; a refused one emits none.
- **The root is ONE MORE NAMED TARGET and no rule changes:** the stream's, the program's (a project root: also the project's) owner or ADMIN may start it. A person who owns only the root program imports under it while their whole-scope preview is a `403`. Every other login is refused by the root's guard BEFORE the token is decrypted and before any Jira call, and again under the apply's plan lock.
- A rooted import writes only under its root, for EVERY caller, so the resolved-target `403` is unreachable for it (kept as defence in depth); it adds no oracle (`BACKLOG.md`, LOW-1).
- **Suggested matches add no route and no right.** The caller cannot CHOOSE a node: an entry is honoured only when it equals the kernel's own suggestion for that row, recomputed under the plan lock in an apply. A BIND made through a confirmed match is guarded FIRST as the CREATE it replaces (the owner chain of the row's resolved parent, the CREATE `403` wording), then as every BIND (`JiraImportMatchGuardTest`). A `suggestion` names a plan node (public) and sits only on a CREATE row; a redacted row never carries one.

Pinned by: `JiraImportPreviewTest`, `JiraImportPreviewGuardsTest`, `JiraImportRedactionTest`, `JiraImportFilterRedactionTest`, `JiraImportPreviewSnapshotTest`, `JiraImportPreviewErrorsTest`, `JiraImportApplyTest`, `JiraImportApplyChangesTest`, `JiraImportApplyErrorsTest`, `JiraImportApplyRaceTest`, `JiraImportChildrenGuardsTest`, `JiraImportChildrenErrorsTest`, `JiraImportChildrenApplyTest`, `JiraImportMatchGuardTest`, `JiraImportDecryptOrderTest`.

### Flow connections, teams and bindings

`flow/FlowConnectionRoutes.kt`, `FlowTestRoutes.kt`, `FlowTeamBindingRoutes.kt`. The connection registry is the Jira registry's matrix verbatim: **ADMIN only on every operation, reads included, `requireAdmin` FIRST** (before the id lookup and the body: a non-admin's probe, unknown id and malformed body are a uniform 403).
The team bindings are **reads any authenticated user's** and **writes the TEAM's ACTIVE manager or ADMIN** (`requireTeamManagerOrAdmin`, asked of the database per request and again under the team row lock through `lockedIsActiveManager`), except "Link all suggested" (ADMIN only). Another team's manager, a project owner, a `ROADMAP_EDITOR`, a stranger and a person-less login are 403. The team routes are **read-before-guard** (team ids are sequential and every login reads the plan).

| Operation | Who | Order |
|---|---|---|
| `GET /integrations/flow/connections` (paged, sortable `id`/`name`/`createdAt`), `POST`, `GET`/`PUT`/`DELETE …/{id}` | ADMIN | `requireAdmin` first; name clash with an active connection 409 (`uq_flow_connections_name_active`); a `PUT` with another `baseUrl` 409 |
| `POST …/connections/test` | ADMIN | 403 before the body → sanitize + validate 400; per-IP `flow-test` bucket; never 502 |
| `POST …/connections/{id}/test` | ADMIN | 403 whether or not the id exists → 404 unknown or deleted; per-IP `flow-test` bucket; never 502 |
| `GET /integrations/flow/origins` | ADMIN | `requireAdmin` FIRST (a uniform 403, nothing read) → 200 `{items}`: the operator's allowed origins (`security.md` "The Flow consumer"); a read, no audit |
| `GET /integrations/flow/teams?connectionId=` | any authenticated user | `connectionId` missing, repeated or malformed 400; the connection ACTIVE (enabled or not) ?: 404 for every caller. Unpaged by decision (`flow-sync.md` "Bindings") |
| `POST /integrations/flow/team-bindings` | the team's ACTIVE manager or ADMIN | body first (**400 first, the Jira bind's documented exception: the team is IN the body**); "The link in order" |
| `DELETE /integrations/flow/team-bindings/{id}` | the binding's team's ACTIVE manager or ADMIN | the binding ACTIVE **and its team ACTIVE** ?: 404 for every caller → `requireTeamManagerOrAdmin` on ITS team 403 → (in the transaction, the row locked) re-read 404 → the guard again 403 → soft delete → 204 |
| `POST /integrations/flow/connections/{id}/team-bindings/match` | ADMIN only | `requireAdmin` FIRST (a uniform 403 whether or not the connection exists, no body) → the connection ACTIVE ?: 404 → enabled 400 → one transaction: dead holders released, every unique folded-name match linked → 200 `{bound, skipped}` |
| `GET /teams/{id}/flow` | any authenticated user | the team ACTIVE ?: 404 for every caller; `can{link, unlink, importCapacity}` is ADMIN or the team's active manager (one verdict three times) |

- **The registry.** The service token is write-only (Rules) and its grammar (`flow_int_` + 43 base64url characters) is checked (`400`); `timeZone` is an IANA region id (`400` otherwise).
- `baseUrl` must be exactly one origin the OPERATOR listed (`security.md` "The Flow consumer"; `400` otherwise, the message never quotes the rejected value) and is the connection's identity; a `PUT` does not ask the list, so an admin can still disable or re-token a delisted one.
- **A test never answers 502:** an upstream failure, a bad token and an undecryptable stored token are rows in a `200` (`me`, then `teams`, SKIPPED when `me` failed). A Flow test never spends a Jira bucket (its own `flow-test`, 10/min by default). The stored variant records the verdict unless an edit raced it and writes no mirror. Audits `flow.connection_created/updated/deleted/tested`.

**The link in order.** Body decodes (400) → the team ACTIVE ?: 404 for EVERY caller (even with a bad `flowTeamId` or connection) → `requireTeamManagerOrAdmin` 403 → `flowTeamId` positive 400. Then, in the transaction (the bind lock): connection active and enabled 400 → the Flow team in the mirror 400 `Unknown Flow team: refresh the connection` → the team row `FOR SHARE` (gone 404) and **the guard again 403**.
Then 409 `already-bound` ("Team X is already linked to Flow team Y", any connection; "Flow team Y is already linked to team Z") unless the Flow team's holder is a DELETED team, which is released → 201 + `Location`.

**What a stranger can learn here, by decision:** the names of the Flow teams of every ACTIVE connection (enabled or not), whether each is linked and to which team, the suggestion, member and sprint counts, the connection's NAME and sync status, plus the `{id, name, enabled}` of every ACTIVE connection (the panel's `connections`, at most 100: how a manager finds a connection to link through); never a base URL, token, zone or interval.
For a linked team: the roster's display names and membership dates; never a base URL, token, account id or email, nor the connection's registry fields. The roster audience is ONE predicate (`rosterVisibleTo`, `RosterAudience.EVERY_LOGIN` in `FlowTeamService.kt`), the one place to narrow it to the manager and ADMIN.

- The link and the match make NO outbound call (they read the mirror) and ride no rate bucket. Audits `flow.team_bound/unbound/teams_matched`.
- A deleted team's binding stays ACTIVE in the table (`teams/` may not name `flow/`) but is invisible: every read filters on active teams, an unlink of it is 404, and the next link of its Flow team (or "Link all suggested") releases it (`flow.team_unbound` reason `TEAM_GONE`).

Pinned by: `FlowConnectionTest`, `FlowTestConnectionTest`, `FlowTeamBindingTest`, `FlowTeamMatchTest`, `FlowTeamPanelTest`, `AuditTest`, `AnonymousAccessTest`.

### Flow capacity import and acknowledge

`flow/CapacityImportRoutes.kt`, `CapacityAcknowledgeRoutes.kt`, `CapacityAcknowledgeService.kt`. All six are **the TEAM's ACTIVE manager or ADMIN** (the import's guard on purpose, `product.md` "Domain decisions"; `can.acknowledge` on the view's item is the same arithmetic as the panel's `can.importCapacity`). Another team's manager, a project owner, a `ROADMAP_EDITOR`, a stranger and a person-less login are 403. The binding is in the path, so there is no body-first exception, and the guard runs before the body (a forbidden caller's malformed body stays 403).

**The common order:** the binding ACTIVE **and its team ACTIVE** ?: 404 for every caller (team ids are public) → `requireTeamManagerOrAdmin` on ITS team 403 → body 400 → (inside the transaction) the guard AGAIN 403 (`lockedIsActiveManager`) → state rule → write.

| Operation | Body 400 | Inside the transaction | Result |
|---|---|---|---|
| `POST …/team-bindings/{id}/capacity-preview` | body decodes, `from` a valid date | none: a computation (no write, no lock, no audit, no outbound call) | 200 |
| `POST …/team-bindings/{id}/capacity-import` | undecodable, a bad `from`, `expected.action` not CREATE/UPDATE, a bad date or figure, a sprint or period named twice, over 2,000 `items` or `removals` | the team row locked (gone 404) → the guard again → the binding re-read after the team lock (a plain read: the binding row is NOT locked) → the writes | team data |
| `POST …/team-bindings/{id}/acknowledge` | `sprintId` REQUIRED (an absent key is refused, `null` names the team's own `TEAM_GONE` row, a number >= 1); `fingerprint` 64 lower-case hex | the binding row `lockActiveForWrite` (gone 404) → re-read with its team ACTIVE (404) → the guard again → rows recomputed → **409 `stale-deviations`** if the named row is absent or its fingerprint differs → write the stamp | 200 |
| `POST …/team-bindings/{id}/acknowledge-all` | `items` 1..2,000, each as the single's body, no `sprintId` twice | the binding row locked once → re-read 404 → the guard again → **409 `stale-deviations`** if ANY named row is absent or has another fingerprint (nothing stored) | rows stamped; 200 |
| `POST …/team-bindings/{id}/unacknowledge-all` | `items` 1..2,000 `{sprintId}`, each `sprintId` ≥ 1 or null, none twice | the binding row locked once → re-read 404 → the guard again → **409 `stale-deviations`** if ANY named row has no stored acknowledgement (nothing deleted) | rows deleted; 204 |
| `DELETE …/team-bindings/{id}/acknowledge?sprintId=` | the query (`optionalLong`: repeated, malformed or < 1 is 400; absent = the team's own row) | the binding row locked → re-read 404 → the guard again → nothing stored for that row: 404 (after the guard) | delete; 204 |

- **The capacity import is a write of TEAM data:** no plan lock, no revision, no outbound call. An unlink committed before the binding's re-read is 404; one committed after it is not noticed. **A MANUAL period is unreachable from the request:** an item is written only when the plan re-computed under the lock still equals its `expected` (an UPDATE's target is the plan's own period, a removal only a Flow-sourced one); everything else is `skipped` `CHANGED`.
- **The acknowledge.** `409 stale-deviations` is a state rule, after the guard and the body, and the ONLY comparison that reads the deviations: the named row's fingerprint is checked against the rows recomputed inside the write's own transaction for THIS binding, never a snapshot read before it; the withdrawal's 404 is likewise decided after the guard, under the lock. No rate bucket. Audits `flow.capacity_deviation_acknowledged` / `…_unacknowledged`; a refused request writes none of its own.
- **`acknowledge-all` is the same arithmetic over a list:** the one guard verdict (outer, then under the binding lock) covers every named row, all or nothing; only the rows the caller NAMES are written.
- **The acknowledge also prunes** this binding's stored rows that are no longer listed, under the same lock and verdict (audit `flow.capacity_acknowledgements_cleared`); the run's prune is the system's and needs no guard.
- **A capacity write prunes too** (`CapacityAcknowledgeService.pruneInCapacityWrite`, inside the write's own transaction under the binding row taken before the team row, through `teams/`'s listener seam). It runs NO guard of its own: the capacity write (POST, PUT, DELETE or the import's apply) already required the TEAM's active manager or ADMIN, re-run under the team row lock, so nobody clears an acknowledgement they could not withdraw. The audit line carries that writer's id (`via=capacity`).

Pinned by: `CapacityImportPreviewTest`, `CapacityImportApplyTest`, `CapacityImportApplyRaceTest`, `CapacityAcknowledgeTest`, `CapacityUnacknowledgeAllTest`, `CapacityAcknowledgeRaceTest`, `AnonymousAccessTest`.

### Sync runs

`sync/SyncRoutes.kt`, `/api/v1/integrations/sync/runs`.

| Operation | Who | Order |
|---|---|---|
| `POST /integrations/sync/runs` | ADMIN only | per-USER `sync-run` bucket on the route node, ahead of the guard (`security.md`) `429` → `requireAdmin` `403` (before the body: a non-admin's malformed body is a uniform 403) → body `400` (malformed JSON, an unknown `kind`) → the connector's runnable check `400` (an unknown, deleted or disabled connection: a body field, the bindings' precedent) → the claim `409 urn:astrolabe:problem:run-in-progress` → `202` |
| `GET /integrations/sync/runs` | any authenticated user | optional `kind` and `connectionId` filters (`400` for a repeated, unknown or malformed value) |

- A non-admin's tenth press is a 403 and the eleventh a 429. `202` is audited `jira.sync_requested` or, for `kind` FLOW, `flow.sync_requested` (the guard order is the same).
- A run names no secret and carries no URL, query or credential (`error_detail` is clamped at write time). Two things the list does not hide, by decision: `errorDetail` can name mapped Jira field ids and an issue-type level to any signed-in login; and with no `connectionId` the list is the 50 newest runs overall, with no signal that older ones exist (the retention keeps 50 per connection).
- **A deleted connection's runs are gone** (the connection DELETE hard-deletes them in its transaction); a claim racing the delete can leave one run row behind (`sync_runs.connection_id` has no FK): no secret, it ends as a failed run (`CONNECTION_GONE`) and falls out of the newest 50.

Pinned by: `SyncRunRoutesTest`.

### The deviation views

`jira/DeviationRoutes.kt` (the deviations and the links), `flow/CapacityDeviationRoutes.kt`. All three are **any authenticated user, a read** (`call.caller()` only; no audit event, no lock, no revision, no `404`: the view is the whole plan, an id that matches nothing filters to nothing). Unknown parameter names are ignored (`list-endpoints.md`); a repeated key or a malformed id, enum or non-strict boolean is a `400`.

| Operation | Who | Notes |
|---|---|---|
| `GET /views/deviations` | any authenticated user | the spec's filters; `connections[]`; per item `fingerprint` and `can{acknowledge}`; per line `deviations[].acknowledgement{at, by, current}` |
| `GET /views/jira-links` | any authenticated user | no parameter; the plan's links |
| `GET /views/capacity-deviations` | any authenticated user | the spec's filters; per row `acknowledgement{at, by, current}`, per item `can{acknowledge}` |

**`GET /views/deviations`: what a login learns.**

- **The `connections[]` block is the one deliberate disclosure:** a non-admin node owner's bind dialog needs a connection id and the registry is ADMIN-only, so the view lists EVERY active connection (enabled or not; **including connections with no bindings**) with `id`, `name`, `siteUrl`, `enabled`, `mappingOk`, `projectKeys`, `lastRun` (never `errorDetail`) and `status` (`SyncStatus`, derived). A login learns whether the site is being read and when it was last read well, never why beyond the machine code.
- New for any login beyond `GET /bindings` (a BOUND connection's id and site host): the NAME, an unused connection's existence, name and host, `mappingOk` (a boolean, never the reason, the field ids or the document) and `projectKeys` (the import dialog needs them; a project key is not a secret). `DeviationViewScopeTest` pins that nothing else of the registry is in the block; a deleted connection is absent. The plan, each binding's node names and its issue data are already every login's.
- **Keys outside the configured projects** (`jira.parentKey` is pattern-checked, not scope-checked; the moved key is the other source, by decision): the gone probe keeps the key Jira answered with and the binding's key follows it (`jira-sync.md`), so a moved item's CURRENT key, which may name a project OUTSIDE every connection's keys, shows to every login in this view, in `GET /bindings` and in the timeline chips' links: one issue key Jira itself gave the connection's account, not a project list.
- **Coverage discloses two more things, deliberately:** the Jira KEYS (never a summary) of the open, unbound issues under a bound program or project (`UNLINKED_IN_JIRA`: `detail.jira`, at most 10, `count` the full figure) and the NAMES of the bound node's unbound plan children (`UNLINKED_IN_PLAN`: names every login already reads), plus an epic's roll-up counts (`jira.rollup`). A key alone identifies no content; no kernel, loader or wire member emits the mirror's summaries.
- **Per item:** `can{acknowledge}` = `PlanPermissions.canAcknowledgeDeviations` (the acknowledge guard's arithmetic, so the UI never offers what the write refuses). The route resolves the caller's person and managed teams once per request (neither for an ADMIN); an unauthenticated computation answers `false`.
- **Hidden rows:** a binding whose node or any ancestor is soft-deleted, or whose connection is deleted, is not listed; a binding of a DISABLED connection IS (it still blocks its node and its issue, so hiding it would answer a bind with a `409` about a link nobody can see or unlink; `jira-sync.md`).

**`GET /views/jira-links`: nothing new.** A link's node, binding, connection id, issue key and `gone` flag are already readable through `GET /integrations/jira/bindings`; a connection's `id`, `name`, `siteUrl`, `enabled`, `projectKeys` and `mappingOk` through `GET /views/deviations`. The hidden rows are the same. Never the email, token, mapping, discovery or a run.

**`GET /views/capacity-deviations`: what a stranger learns, by decision.**

- The team names and the linked Flow team names (already in the team page's Flow panel), the capacity figures per sprint (the team's periods are readable by every login through `GET /teams/{id}/capacity`; **Flow's own per-sprint figures** `flowMd`, `flowTotalMd` are new to a non-manager, since the capacity preview that returns them is the team manager's, and are accepted as the same class), and the ACTIVE connections' `id`, `name`, `enabled`, derived `status` and `teamsAt`.
- **Never** a base URL, a token, the poll interval, the test detail or an account id; the `zone` on an item is the connection's IANA time-zone name (a zone is not a secret).
- `acknowledgement.by` (here and on a deviations line) is the acknowledging login's ACTIVE person's name, else its display name, never an email, null once the login is deleted (`creatorsOf`, the `createdBy` rule). `can.acknowledge` is ADMIN or the team's ACTIVE manager (the import's arithmetic), resolved ONCE per request (`TeamService.activeManagedTeamIds`, skipped for an ADMIN), never from a token claim; a hint, the write's guard decides. Nothing is written, so no audit event.

Pinned by: `DeviationViewTest`, `DeviationViewScopeTest`, `JiraLinksViewTest`, `AnonymousAccessTest`.

## Tests

- `GuardsTest` covers the guard matrix; `AnonymousAccessTest` sweeps the 401 surface FROM THE SPEC (plus the forged-secret and jti-less token cases); `UserRoutesTest` the management CRUD and protections (`TestUsers.withSoloAdmins` isolates the last-admin 409s); `PasswordChangeTest` the self-vs-admin rules; `AuditTest` the denial and mutation events.
- Each route family's tests are listed on its "Pinned by:" line.

## Not yet ported

- **The HR read-only auditor role** (audited `hr.read`/`hr.list` cross-user reads) and Lettuce's rule that every HR-privileged read is audit-logged.
- **The management-chain rule** (`teams/ManagementChain.kt`, transitive manager rights): **deliberately NOT ported**, Astrolabe's teams are flat (ONE optional direct manager). Port only if a hierarchy of teams ever becomes a requirement.
