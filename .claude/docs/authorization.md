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
- **Roles vs permissions (V11).** Two different mechanisms, deliberately: **roles** (`ADMIN`) ride the JWT (`roles` claim) and are verified against
  `users.role` on every request by the access check, so a role change is a `401 roles_changed` on the very next request; **permissions** (`Permission`
  in `users/User.kt`, today `ROADMAP_EDITOR`) are **rows of `user_permissions` read from the database per request** (`UserService.hasPermission`) and
  are NEVER a token claim and never cached — so a grant or a revoke takes effect on the target's next request with no refresh, no re-login and no
  `401`. They are also not the V5 feature flags (a DISABLED set, default-on, riding the token and lagging to the next refresh): a permission is an
  additive GRANT, default-off. `CallerPrincipal` therefore carries no permissions; a guard that needs one takes the lookup as an injected
  `suspend (userId, Permission) -> Boolean` (the `requireTeamManagerOrAdmin` shape), keeping `GuardsTest` pure. `UserResponse.permissions` is the
  ADMIN-facing reading of the set, not an authorization input.
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
  answers false for a missing team so the 403 is uniform — consumed by the milestone schedule PUT since V14, below), plus
  `requireFeatureEnabled` (awaiting its first area-gating consumer), and the planning guards (V11; each pure-tested in `GuardsTest`):
  `requireOwnerOrAdmin(caller, callerPersonId, chain)` (ADMIN, or the caller's person is on the node's `OwnerChain` — work stream, program, project owners
  top-down; a caller with no active person owns nothing) and `requireTargetWindowEditorOrAdmin(caller, callerPersonId, chain, hasPermission)` (given the node's
  FULL chain: ADMIN, an owner ABOVE the project, or the grant; the project's own owner alone is refused, and the person-id check runs before the database
  lookup) are consumed by the plan routes (V12, below); `requireRoadmapEditorOrAdmin(caller, hasPermission)` (ADMIN short-circuits without the lookup; else the
  caller must hold `ROADMAP_EDITOR`; a throwing lookup propagates — fails closed) is consumed by `PUT /roadmap/ranking` (V13, below). New guards join this file so the whole policy stays in one place.
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
    `managerPersonId` (create and the full-replace PUT — omitted = no manager) must be an ACTIVE person of the people directory,
    else `400` ("Unknown or deleted manager ids"); `TeamResponse`/`TeamListItem` carry `managerPersonId` +
    `managerName`, both null for a soft-deleted manager person. Being a team's manager grants NO write on the team
    record itself (still ADMIN only) — the manager's rights are the team-scoped ones the planning increments add
    (milestone scheduling since V14, the team's capacity periods since V16, the team milestone order since V17; `product.md`), via `requireTeamManagerOrAdmin`. A team delete is `409` ("Team still has milestones") while an ACTIVE milestone names the team. Since V10 the manager is a
    person of the people directory (`teams.manager_person_id` replaced `manager_user_id`; the manager's login is `people.user_id`). Mutations audit `team.created/updated/deleted` and `team.manager_changed`
    (only on an actual change). Tests: `TeamTest`, `GuardsTest`.
  - `/api/v1/people` (V10, the people directory) → `GET` list and `GET /{id}` **any authenticated user, emails included** (the owner and
    manager pickers and the People page read it; the plan's owners are people, and non-admin stream/program owners pick owners for the
    nodes they create); `POST` and `PUT`/`DELETE /{id}` **ADMIN only**, `requireAdmin` BEFORE the body decodes and the id lookup
    (guard-before-read, the teams rule: a non-admin's probe and malformed body are a uniform 403). The email is optional and unique among
    ACTIVE people (case-insensitive, `409`); names are not unique. The optional `userId` links a login — an ACTIVE user (`400` otherwise)
    not linked to another active person (`409`); only an ADMIN sets it (a login link is a rights path: the person's owner rights ride it),
    and a change of the link is audited on its own (`person.link_changed`). `PersonResponse` resolves `userId`/`userEmail` through ACTIVE
    users (null for a soft-deleted login — the link stays inert, never an access grant: the caller's person is `people.user_id = caller AND
    people.active()`, and a deleted login never passes the per-request access verdict). Delete is `409` while the person manages an ACTIVE
    team or owns an ACTIVE work stream, program or project ("Person is still an owner or a team manager"). Tests: `PersonTest`.
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
  - `PUT /api/v1/users/{id}/permissions` (V11) → ADMIN only, `requireAdmin` BEFORE the body decodes (a non-admin's probe, unknown id and malformed body are a
    uniform 403); **self allowed** (the features precedent); unknown/soft-deleted target → 404; unknown permission name → 400 (enum decode); wholesale
    replace of the GRANTED set (idempotent — a same-set re-PUT is 204 and audits nothing; an empty array revokes everything); audited
    `user.permissions_changed` (permissionsFrom/permissionsTo) only on an actual change. Takes effect on the target's next request ("Roles vs
    permissions" above). `UserResponse.permissions` carries the set on `GET /users/{id}` and the list. SPA: `/users/:id/permissions` (the Users row menu's
    Permissions item). Tests: `UserPermissionsTest`, `GuardsTest`.
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
    `requireTeamManagerOrAdmin` asks `TeamService.isActiveManager` (an ACTIVE team whose manager is an ACTIVE person with
    `people.user_id` = the caller AND an ACTIVE user) per request, so assigning or clearing a manager takes effect on the very next request (a
    soft-deleted manager's token is already a `401` at the access check; the ACTIVE-user predicate stays as the second
    line); its ADMIN short-circuit rides the (verified) JWT roles. Never cache the verdict in a claim. A route that merely
    SHAPES its answer by the grant (e.g. whether a block of per-person figures is returned) asks `isActiveManager` the same way, after
    the ADMIN short-circuit; the `ETag` of such an answer carries the verdict ("Caching" in `security.md`). It is
    the Flow-donated seam; V10 re-pointed it at `manager_person_id` → `people.user_id`. Its first consumer is `PUT /milestones/{id}/schedule` (V14, below), which re-runs it inside the plan lock through
    `TeamService.lockedIsActiveManager` (`FOR SHARE OF teams, people`), so a manager change commits first (403) or waits; the capacity writes (V16, below) are the second consumer, re-running it under the TEAM row lock instead.
  - **The plan nodes (V12, built) — the owner-scoped matrix** (`product.md` "Domain decisions"; `planning/*Routes.kt`): ADMIN everything; ownership cascades down (work
    stream → program → project: an owner at ANY level of a node's chain acts on the node); reads open to every authenticated user. **Read-before-guard**, the sanctioned
    idiom (ids are sequential and every signed-in user reads the whole plan anyway, so existence is no secret): resolve the node's owner chain (`WorkStreamService.chain`
    …) → missing = `404` for EVERY caller → the guard `403` → `call.receive` (a forbidden caller's malformed body stays 403) → validate `400` → write under the plan lock
    (`409` name clash or active children). The caller's person is resolved once per request (`PersonService.activePersonIdOf`, not looked up for an ADMIN); the grant is read
    per request, never from the token. **The guard runs twice**: outside, before `call.receive`, for the 404 → 403 → 400 ordering; and again INSIDE `withPlanWrite` against a chain re-read under the plan
    lock, the caller's person re-resolved `FOR SHARE` and (target window) the grant re-read in the same transaction — a request can be held open after the outer guard (a slow body; Netty's idle-read
    timeout is only a gap bound, `security.md` "Slow requests"), so only the inner verdict authorizes the write (a failure there is a 403 with no revision bump and the central `authz.denied`). Rule per route:

    | Route | Guard (in order) |
    |---|---|
    | `GET` any node, `GET /views/plan`, `GET /projects`, `GET /milestones` (v0.4 paged picker lists) | authenticated; 400 paging/sort/repeated `name` |
    | `POST /work-streams` | `requireAdmin` first (it addresses no node: guard-before-read) |
    | `PUT`/`DELETE /work-streams/{id}`, `POST /work-streams/{id}/programs` | chain(stream) ?: 404 → `requireOwnerOrAdmin` (the stream's owner) |
    | `PUT`/`DELETE /programs/{id}`, `POST /programs/{id}/projects` | chain(program) ?: 404 → `requireOwnerOrAdmin` (the stream's or the program's owner) |
    | `PUT`/`DELETE /projects/{id}` | chain(project) ?: 404 → `requireOwnerOrAdmin` (any of the three, the project's own owner included) |
    | `POST /programs/{id}/move` | chain(program) ?: 404 → `requireAncestorOwnerOrAdmin` (the stream's owner; NOT the program's own owner) → body 400 → target work stream chain ?: **400** "Unknown or deleted work stream ids: N" (a body field, never a 404) → `requireOwnerOrAdmin` on the TARGET chain: BOTH, or ADMIN |
    | `POST /projects/{id}/move` | chain(project) ?: 404 → `requireAncestorOwnerOrAdmin` (the program's or stream's owner; NOT the project's own owner) → body 400 → target program chain ?: **400** "Unknown or deleted program ids: N" → `requireOwnerOrAdmin` on the TARGET chain (both, or ADMIN); 409 name clash in the target program |
    | `PUT /projects/{id}/target-window` | chain(project) ?: 404 → `requireTargetWindowEditorOrAdmin` (ADMIN, the stream's or program's owner, or `ROADMAP_EDITOR`; NOT the project's own owner alone) |
    | `GET /views/roadmap` | authenticated (`can.editRank` shows the caller's right to rank, each project's `can.editTargetWindow` the right to move its band; no audit, a read) |
    | `GET /views/programs` | authenticated (the project rows carry the roadmap's `can.editTargetWindow`; programs and work streams carry no `can`; no audit, a read) |
    | `PUT /roadmap/ranking` | `requireRoadmapEditorOrAdmin` FIRST — **guard-before-read**: the route addresses no node, so there is no 404 to order against; ADMIN or `ROADMAP_EDITOR`, nobody else (an owner of any node included) |

    **A move needs both sides** — the right to take the node out of where it is AND the right to create one where it goes. The source side is `requireAncestorOwnerOrAdmin` on the node's chain: ADMIN or an owner ABOVE the node
    (`chain.ancestors`, the `requireTargetWindowEditorOrAdmin` slicing) — the node's own owner alone may NOT move it, so "the ancestors can always take it back" holds and a hand-over cannot dodge the parent's say. The target side is
    `requireOwnerOrAdmin` on the candidate parent's chain (what creating a child there needs). Both guards run outside for the ordering (source before the body, target after it) and again INSIDE `withPlanWrite`, each against its
    chain re-read there (`MoveGuards`, one `FOR SHARE` lookup of the caller's person shared by both; the source missing = 404, the target missing = 400, nothing written). The plan view carries the source half as `can.move` on every
    program and project (`PlanPermissions.canMove`, pinned against the guard by `PlanPermissionsTest`) and the target half is the candidate's existing `can.createProject` / `can.createProgram`: the SPA offers "Move to…" when `can.move` is
    set, with the candidates whose create flag is set, and `PlanMoveTest` pins that conjunction against the real moves. The ownership arithmetic afterwards reads the NEW chain (a guard or a flag never remembers the old parent).
    The owner of a node is a field of its full-replace PUT, so **any caller who may edit a node may reassign its owner** (including the node's own owner — a hand-over;
    the ancestors can always take it back); the new owner must be an ACTIVE person (`400` "Unknown or deleted owner ids"). Creating a project may carry the target window
    (creators are always window editors). A closed work stream (end date) does not block new children. The `can:{}` flags of the plan view come from the pure kernel
    `planning/PlanPermissions.kt` with the SAME arithmetic as these guards (`PlanPermissionsTest` pins the agreement; `PlanViewTest` checks the flags against real writes).
    **The ranking PUT (V13)** runs `requireRoadmapEditorOrAdmin` before `call.receive` (a forbidden caller's malformed body stays 403, and the grant lookup is a database read per request, never a token claim) and
    AGAIN inside `withPlanWrite` after the lock is taken: a request can be held open after the outer guard (a slow body, or waiting behind another plan writer), and a grant revoked in between must refuse the write —
    the same TOCTOU rule as the owner guards (a failure there is a 403, no revision bump, the central `authz.denied`). The `409` stale-revision and the `400` id errors come after the guard. `can.editRank` is
    `PlanPermissions.canEditRank` (ADMIN or the grant), pinned against the guard by `PlanPermissionsTest` and against the real PUT by `RoadmapRankingTest`.
    Tests: `PlanStructureTest` (every route × ADMIN, the three owners, a stranger, a person-less login, a roadmap editor; 404 vs 403 ordering), `PlanViewTest`, `PlanPermissionsTest`, `RoadmapRankingTest` (ADMIN, a roadmap editor, an owner without the grant, a stranger, a person-less login; the revocation under a held lock).
  - **Milestones (V14, built) — the plan fields and the dates have different audiences.** A milestone has no owner: its plan fields (name, description, team, estimate) are written by the owner chain of its PROJECT
    (any of the three, the project's own owner included) or ADMIN; its DATES only by the manager of its team or ADMIN. A project owner who is not that manager gets 403 on the schedule PUT (the product rule of v0.3.0), and a
    team manager who owns nothing on the chain gets 403 on every plan-field write. Reads open to every authenticated user. Read-before-guard throughout; the guard runs twice (outside for the 404 → 403 → 400 ordering, inside
    `withPlanWrite` against the chain re-read there — for the schedule PUT against the milestone's STORED team, the manager re-looked up with `FOR SHARE OF teams, people`); the schedule PUT then compares the milestone's
    `schedule_revision` (409 stale-revision only after the guard: a manager revoked meanwhile is a 403, not a 409).

    | Route | Guard (in order) |
    |---|---|
    | `GET /milestones/{id}` | authenticated; 404 when the milestone or any ancestor is gone |
    | `GET /views/project/{id}` | authenticated; 404 when the project or any ancestor is gone (for every caller); the caller's rights ride in the `can` flags (below) |
    | `POST /projects/{id}/milestones` | chain(project) ?: 404 → `requireOwnerOrAdmin` (the project's own owner included) → body 400 (inactive team, estimate, name), 409 name in project; 201 + `Location` |
    | `PUT`/`DELETE /milestones/{id}` | `milestoneChain` ?: 404 → `requireOwnerOrAdmin(chain.owners)` |
    | `PUT /milestones/{id}/schedule` | `milestoneChain` ?: 404 → `requireTeamManagerOrAdmin(caller, chain.teamId, teams::isActiveManager)` → body/validation 400 (a negative `expectedRevision` included) → (under the lock) chain re-read 404 → the guard again with `lockedIsActiveManager` 403 → 409 stale (below the milestone's own revision or above the plan's) |
    | `DELETE /projects/{id}` | unchanged guard; cascades the project's milestones |
    | `DELETE /teams/{id}` | `requireAdmin` (unchanged); 409 while an ACTIVE milestone names the team |

    **The `can` arithmetic for milestones (the project view, `PlanPermissions`).** `project.can.createMilestone` = `canCreateMilestone` = `canManage(projectChain)` (`requireOwnerOrAdmin` on the project's chain, the project's own owner included); a milestone's
    `can.edit`/`can.delete` = `canManage(projectChain)` (the milestone has no owner of its own); a milestone's **`can.schedule` = `canSchedule(actor, milestone.teamId)` = ADMIN, or the caller currently manages THAT milestone's team** (`requireTeamManagerOrAdmin` against the stored team) —
    so a project owner sees `schedule: false` on every milestone unless they also manage its team, and a team manager sees `schedule: true` only on their own teams' milestones and `edit`/`delete: false` unless they also own something on the chain. The actor's `managedTeamIds`
    is looked up once per request for a non-admin (`TeamService.activeManagedTeamIds`, an ACTIVE team whose manager is an ACTIVE person linked to this ACTIVE user — `isActiveManager`'s predicate without the team id; never a token claim) and is empty for an ADMIN, who needs no lookup.
    `PlanPermissionsTest` pins `canCreateMilestone` and `canSchedule` against the guards table-driven (every actor × every team); `ProjectViewTest` checks every flag against the real write it mirrors.

    Tests: `MilestoneTest` (every plan-field route × ADMIN, the three owners, a stranger, a person-less login, a roadmap editor, a team manager), `MilestoneScheduleTest` (the manager, the other team's manager, ADMIN, the project
    owner — named — and the rest; the held-request re-guard cases).
  - **Dependencies (V15, built) — the SUCCESSOR's project chain is the guard.** A link is a plan field of its successor (the constrained side: "it waits for the predecessor"), so it is written by an owner on the SUCCESSOR's project chain — the project's own owner included —
    or ADMIN; the PREDECESSOR's owner is asked nothing (a link never moves a date) and may neither create, edit (type and lag) nor delete a link another project depends on; a team manager as such has no say. **The one exception, the cascade:** deleting an endpoint (a milestone, or a project with its milestones) soft-deletes every link at it, whichever side owns them — the endpoint's own guard authorizes that, a link cannot outlive an end, and the successor's owner is not asked (audited as the delete's `dependencyIds`, `observability.md`). Reads are open to every authenticated user. Read-before-guard throughout; the guard
    runs twice (outside, then inside `withPlanWrite` against the chain re-read there with the caller's person `FOR SHARE`). A forbidden caller's malformed body stays 403.

    | Route | Guard (in order) |
    |---|---|
    | `POST /projects/{id}/dependencies` | chain(project) ?: 404 → `requireOwnerOrAdmin` (the project's own owner included) → body 400 (type/kind decode, lag range, self-link) → (under the lock) chain re-read 404 → the guard again 403 → successor must be the project or one of its active milestones 400 → predecessor active 400 → **409 cycle** (`urn:astrolabe:problem:dependency-cycle`, `cycle` as data) → insert (**409** duplicate ordered pair); 201 + `Location` |
    | `GET /dependencies/{id}` | authenticated; 404 when the link or either end's chain is gone |
    | `PUT /dependencies/{id}` | `dependencyChain` (the successor's project chain) ?: 404 → `requireOwnerOrAdmin` on it → body 400 (decode, lag range) → (under the lock) chain re-read 404 → the guard again 403 → a changed type: **409 cycle** on the graph without this link's old edge → update; 204 |
    | `DELETE /dependencies/{id}` | `dependencyChain` (the successor's project chain) ?: 404 → `requireOwnerOrAdmin` on it → (under the lock) chain re-read 404 → the guard again 403 → 204 |
    | `DELETE /milestones/{id}`, `DELETE /projects/{id}` | unchanged guards; cascade the links at either end |

    The named product-rule tests (`DependencyTest`): "the predecessor's project owner alone cannot create the link" and "… cannot delete it", "a team manager who owns nothing on the chain cannot link", "a forbidden caller's malformed body stays 403". Every 403 is the central
    `authz.denied`. **The `can` arithmetic for links (the project view, `PlanPermissions`):** `project.can.createDependency` = `canCreateDependency(projectChain)` = `canManage` (the same arithmetic as `createMilestone`); each link's `can.edit` = `canEditDependency` and `can.delete` = `canDeleteDependency(successor's project chain)` (two flags, one arithmetic today, so the day they diverge no client changes) = `canManage` on the chain of the project that holds the link's SUCCESSOR — the viewed project's own chain, or, for a link whose successor lives in another project, that project's chain from one batched `projectChains(ids)` read (a chain that is gone = `false`). So the owner of the predecessor's project sees `delete: false` on the link into someone else's project, and `createDependency: false` on a project they do not own. `PlanPermissionsTest` pins all three against `requireOwnerOrAdmin` table-driven; `ProjectViewDependenciesTest` checks the flags for every kind of caller against the real `POST`, `PUT` and `DELETE`; `DependencyUpdateTest` pins the PUT's guard order (404 before 403 before the body, a forbidden caller's malformed body stays 403).
  - **Team capacity periods (V16, built) — team data, written by the team's manager or ADMIN** (`teams/TeamCapacityRoutes.kt`; the project's owner and every other caller get 403). **Read-before-guard** (team ids are sequential and every signed-in user reads the plan):
    the team (or the period's team) is resolved first — missing or deleted = `404` for EVERY caller — then `requireTeamManagerOrAdmin` (403), then `call.receive` (a forbidden caller's malformed body stays 403), then validation (400), then the write. **The guard runs twice**: outside, with
    `TeamService.isActiveManager`, for the 404 → 403 → 400 ordering; and again INSIDE the write's own transaction with `TeamService.lockedIsActiveManager` AFTER the team row is locked `FOR NO KEY UPDATE` (a team delete racing it either commits first — 404 — or waits), so only the inner verdict
    authorizes the write; capacity takes NO plan lock (it is not plan state).

    | Route | Guard (in order) |
    |---|---|
    | `GET /teams/{id}/capacity`, `GET /capacity-periods/{id}` | authenticated; 404 when the team / the period (or its team) is deleted |
    | `POST /teams/{id}/capacity` | team active ?: 404 → `requireTeamManagerOrAdmin` → body 400 (date shape or year, `mdPerWeek` range/decimals, `wipLimit` outside 1..99) → (in the transaction) team locked, gone = 404 → the guard again 403 → insert (**409** the partial index); 201 + `Location` |
    | `PUT /capacity-periods/{id}` | the period's team ?: 404 → the guard on THAT team → body 400 → (locked) re-read 404 → the guard again 403 → replace (**409** on a date clash) → 204 |
    | `DELETE /capacity-periods/{id}` | the same → 204 |
    | `DELETE /teams/{id}` | unchanged (`requireAdmin`); cascades the team's ACTIVE periods after the milestone 409 |

    The named product-rule tests (`TeamCapacityTest`, `TeamCapacityLifecycleTest`): "the team's manager and ADMIN add a period - the project owner and every other caller get 403, whatever they own", "a forbidden caller's malformed body stays 403", "a manager cleared from the team while a write was held
    is refused". Every 403 is the central `authz.denied`.
  - **The team milestone order (V17, built) — written by the team's manager or ADMIN** (`planning/TeamOrderRoutes.kt`; the project's owner and every other caller get 403). **Read-before-guard** like the schedule PUT (team ids are sequential and every signed-in user reads the plan): the team resolved first
    (`PlanRouteDeps.requireTeamManager`: missing or deleted = `404` for EVERY caller), then `requireTeamManagerOrAdmin` (403), then `call.receive` (a forbidden caller's malformed body stays 403), then validation (400). **The guard runs twice**: outside with `TeamService.isActiveManager`, and again INSIDE the plan-locked write with
    `TeamService.lockedIsActiveManager` (`FOR SHARE OF teams, people`; `PlanRouteDeps.teamManagerGuard`), so only the inner verdict authorizes the write — a manager cleared while the request waited at the lock is a 403, no bump.

    | Route | Guard (in order) |
    |---|---|
    | `PUT /teams/{id}/milestone-order` | team active ?: 404 → `requireTeamManagerOrAdmin` → body 400 (negative `expectedRevision`, more than 1000 ids, an id twice) → (under the plan lock) team re-read 404 → the guard again 403 → **409 stale** (`stale-revision`, against the TEAM's own order revision) → ids active and of this team 400 → rewrite → 200 `{revision}` |

    The named product-rule tests (`TeamOrderTest`, `TeamOrderLifecycleTest`): "the team's manager and ADMIN reorder - the project owner and every other caller get 403, whatever they own", "an unknown or deleted team is 404 for every caller, and a forbidden caller's malformed body stays 403", "the 400s come after the guard" (a milestone of another team
    in the list is 400 only for a caller who passed the guard), "a manager cleared while the PUT waits at the plan lock is refused". Every 403 is the central `authz.denied`.
  - **The team view's `can` flags (built, v0.5.0 C3; `GET /views/team/{id}`, any authenticated user, 404 when the team is deleted).** `team.can.schedule`, `editCapacity` and `editOrder` are ONE arithmetic under three names — `PlanPermissions.canSchedule` / `canEditCapacity` / `canEditTeamOrder`: ADMIN, or `teamId in actor.managedTeamIds` (the caller is the ACTIVE manager of THIS team,
    `requireTeamManagerOrAdmin`'s arithmetic; resolved once per request with `withManagedTeams = true`). Never the project's owner as such. Three flags so a later version may split the rights without a wire change. `PlanPermissionsTest` pins each against the guard; `TeamViewTest` "the three flags are set exactly where the server lets the real write through" checks each against the schedule PUT, the capacity POST and the order PUT for every kind of caller.
  - **The roadmap view's `can.editTargetWindow` (built, v0.6.0 C1; `GET /views/roadmap`, any authenticated user).** Per project row: `PlanPermissions.canEditTargetWindow(actor, chain)` — ADMIN, the caller's person among the owners ABOVE the project (`chain.ancestors`), or the `ROADMAP_EDITOR` grant;
    the project's own owner alone is not enough — exactly `requireTargetWindowEditorOrAdmin`'s arithmetic, on the chain read in the same statement as the row (no second lookup). `RoadmapViewTest` checks the flag against the real `PUT /projects/{id}/target-window` for ADMIN, each owner, an editor, a stranger, a person-less login and a team manager. The view adds no guard and no audit event.
  - **The programs view (built, v0.6.0 C2; `GET /views/programs`, any authenticated user).** Its project rows are the roadmap's `RoadmapProject` (the same `can.editTargetWindow` arithmetic above, on the chain read in the same statement as the row); the program and work stream nodes carry only derived spans and flag counts, no rights. No guard, no audit event, no 404 (the view is the whole plan).
  - **The public-holiday dictionary (V19, built v0.7.0; `planning/PublicHolidayRoutes.kt`) — written by ADMIN only, GUARD-BEFORE-READ** (the `teams/` registry shape, not the plan nodes' read-before-guard: the dictionary is a flat ADMIN registry with no owner chain, so a non-admin probe learns nothing about which ids exist). `GET /public-holidays` is any authenticated caller. `requireAdmin` runs BEFORE `call.receive` and before the id lookup; a plain user's malformed body or unknown id is 403, never 400/404. The writes are plan writes (`withPlanWrite`) but the plan lock is not an authorization: there is no inner re-guard, exactly like the other ADMIN-only registries (`teams/`, `people/`): the ADMIN role is the one `requireAdmin` reads from the per-request-validated principal.

    | Route | Guard (in order) |
    |---|---|
    | `POST /public-holidays` | `requireAdmin` 403 → body 400 (ISO date 1900-2999, name 1..100 single-line) → insert (**409** `uq_public_holidays_date`) → 201 + `Location` |
    | `POST /public-holidays/apply-preset` | `requireAdmin` 403 → body 400 (unknown preset, year outside 1900..2999) → insert the missing dates → 200 `{added, skipped}` |
    | `DELETE /public-holidays/{id}` | `requireAdmin` 403 → (under the plan lock) row gone 404 → 204 |

    The named product-rule tests (`PublicHolidayTest`, `HolidayPresetTest`): "mutations are ADMIN-only and the guard runs before the body and the id lookup", "only ADMIN may apply a preset and the guard runs before the body is read". Every 403 is the central `authz.denied`.
  - **Still planned:** each new rule lands here with its
    guard order (403 before 400/404, guard-before-read where existence is sensitive) in the same commit as its route.
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
  `NotFoundException` (→ 404), `ConflictException` (→ 409; it may carry an RFC 7807 extension member as data — `cycle`, the `ProblemCycleNode` list of the dependency-cycle problem, serialized as `ProblemDetail.cycle` and omitted otherwise), and `TooManyRequestsException` (→ 429) live
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