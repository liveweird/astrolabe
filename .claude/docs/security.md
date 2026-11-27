# Security

Owns: the server's and the deployment's security posture: development vs production mode and the startup checks, tokens and sessions, response headers and caching, the login throttles, password reset, rate limits, email MFA, request limits, the outbound-call guard, encryption at rest, log hygiene, Kubernetes and compose hardening, and what telemetry discloses. Not here: who may call what (`authorization.md`), the audit events (`observability.md`), the validators' order of evaluation (`planning-model.md` "View validators"), the SPA's session code (`web-internals.md`, `web/CLAUDE.md`).

## Rules

The rules that bind every change in this area. The sections below hold the mechanics and the pinning tests.

- Production mode (`ktor.development=false`, the image's default) adds HSTS, the HTTPS redirect and four fail-closed startup checks in the infrastructure modules, in module order (JWT secret, mail transport, data-encryption key, seed passwords); the connector refusals (`jira.stubBaseUrl`, `flow.insecureOrigins`) and the MFA code-TTL floor follow in their own modules. A malformed key or `MAIL_APP_URL`, and `smtp` with a blank host, refuse boot in ANY mode. Development only warns; "Everything development mode relaxes" is the complete list.
- Every authenticated request runs ONE uncached database statement (`TokenBlocklistService.accessVerdict`): a logout, delete, demotion or password change ends a token on its next request, on any replica. A verdict rejection is a `401` with ONE text, audited `access.rejected`; a lookup that THROWS is a `500`, never a `401`. The verifier requires audience, issuer, `typ == "access"` and a PRESENT `jti` (`/refresh` too).
- Both tokens live in the SPA's `localStorage`; the control is keeping foreign script out. Never weaken `script-src`; the SPA stays free of `dangerouslySetInnerHTML`/`eval`; the Swagger UI is the ONLY CSP exemption.
- `/refresh` CLAIMS the presented token atomically (`INSERT .. ON CONFLICT DO NOTHING` into `revoked_tokens`); the replay grace is 60 s by default (`REFRESH_REPLAY_GRACE_SECONDS`, 0 = strict) with at most 2 re-mints per token; a logout that reaches the route body ends the grace; there is NO family-wide revocation.
- Every `/api/` answer is `Cache-Control: no-store`. Only the ten view GETs revalidate (`respondRevalidated`), and authentication, parameters and the view's own `404`/`400` run BEFORE any validator logic.
- Login: an unknown email pays a discarded cost-12 bcrypt verify. Lockout: 5 consecutive failures lock an email for 900 s (defaults; `security.lockout.*`), `429` even with the right password, whether or not the account exists. A throttle's `429` is THROWN (`TooManyRequestsException`), never `respondProblem`ed.
- A new password (create, change, reset, bootstrap) is at least 10 characters and at most 71 UTF-8 bytes (`validatePassword`). Login's `verifyPassword` treats anything over 71 bytes as a wrong password (the bcrypt ceiling: a throw would be a 500-vs-401 oracle); login has no minimum. Validators run AFTER the authz guard (403 before 400).
- Self password change: its own `LoginThrottle` per USER id; order `429` (bucket), `403`, `429` (lock), `400`, `403` (wrong current); the new password is validated BEFORE the current one on purpose.
- Password reset: a uniform async `202` that changes nothing; only a token's SHA-256 digest is stored; at most 5 unexpired grants per account; the grant is checked BEFORE any bcrypt; success is `204` with no auto-login; the link's origin is `mail.appUrl`, configured and never derived from `Host`; the token sits in the URL fragment.
- Email MFA is opt-in (the one inverted-default flag); every code failure is a uniform `401`; MFA failures never feed the lockout; a mail-less deployment answers `503` to an MFA-enabled login.
- Every rate-limit bucket speaks `Retry-After` and no `X-RateLimit-*`. A per-USER bucket keys on the verified user id and, mounted on the route node, runs before the guard (a request that would be `403`/`404`/`400` spends a token too).
- In-memory auth state (lockout, MFA challenges, reset cooldowns) is per instance and capacity-bounded with audited `429` saturation; rotation records are bounded too, but drop the new record (strict fallback), no `429`. The app runs ONE replica.
- Body ceiling 10 MiB (`413`); read timeout default 60 s (0..3600); every pool statement has a 15 s limit (default), except the telemetry reads and Flyway.
- Every server-initiated HTTP call goes through `infra/outbound/`: a host allow-list first, addresses re-checked on every NEW connection, no proxy, no redirects, no OkHttp retry, a bounded response read. `outbound.blocked` carries scheme and host ONLY, never a URL. A private host widens the guard from OPERATOR configuration only. An upstream token never reaches a URL, a log line, an audit line, a problem body or a probe row.
- Sensitive columns are AES-256-GCM `enc:v1:` envelopes under `DATA_ENCRYPTION_KEY`, never in the database; losing the key loses every encrypted value. A rotation boot that meets an envelope neither key opens fails closed. Never remove an `encryptedAtRestServices()` registration; never filter or sort on an encrypted column in SQL. A credential column is write-only end to end and never decrypted on a read path; the Jira registry has exactly three decrypting methods.
- A class carrying a secret overrides `toString()` through `maskedSecret`; a log or audit line carries a host, a scheme or a class name, never a full URL or a value.
- The base `k8s/front-door.yaml` is the production posture and is unsafe behind a bare LoadBalancer; the local overlay runs development mode. Pods run non-root with `drop: [ALL]` and no service-account token; the network policy denies all by default. `V3__seed_admin.sql` is never edited; production neutralizes the seed at startup.
- Telemetry discloses numbers and fixed labels to ADMINs only; metric-name cardinality is bounded.

## Security posture: development vs production mode

`ktor.development` is env-overridable (`$KTOR_DEVELOPMENT:true`): local `:server:run` and the tests default to development mode;
**the Docker image ships `KTOR_DEVELOPMENT=false`** (production mode), and `docker-compose.yaml` sets it back to `true` because it is
the local plain-HTTP demo. Production mode activates HSTS, the HTTPS redirect and the fail-closed startup checks.

### The startup checks

They fire in module order (JWT, mail, crypto, then the seed passwords after the database), so a test asserting a later check
satisfies every earlier one (the boot-test overrides are `testing.md`'s).

- **JWT secret** (`plugins/Security.kt`): production requires a private 64-character hex key generated with `openssl rand -hex 32`.
  Blank, malformed, repeated-character and publicly committed values (including the compose demo key and the Kubernetes template
  placeholder) refuse startup. Development warns and retains its demo behavior. The format check cannot establish randomness;
  generate and store the key privately.
- **Mail transport** (`infra/mail/Mail.kt`): `mail.transport=log` writes outbound email (reset links and MFA codes included) into
  the application log - a warning in development, **refuse to start** in production; `smtp` with a blank host refuses in **any**
  mode. A non-blank `mail.appUrl` must be the deployment's `https` origin (`http` only in development; a host, no path beyond `/`,
  userinfo, query or fragment, at most 2048 characters - a wrong origin would mail reset tokens to another host) or startup is
  refused in **any** mode; blank is allowed (the reset answers 503 and boot warns). See "Outbound email".
- **Data-encryption key** (`infra/crypto/Crypto.kt`, `configureCrypto`, right after `configureMail` and BEFORE `configureDatabase`):
  blank or the burned repo-committed dev default warns in development and **refuses to start** in production; a malformed key (not
  64 hex chars - the k8s template placeholder included) refuses in ANY mode. See "Encryption at rest". Covered by `CryptoBootTest`.
- **Seed passwords** (`infra/db/Bootstrap.kt`, `configureBootstrap`, after `configureDatabase`): in production, if any active account
  still carries the well-known `changeme` bcrypt hash the app **refuses to start**. The seed admin is also checked against known
  plaintexts, so a freshly salted hash of an unsafe initial password from an older build cannot pass the hash-equality check.
  `ADMIN_INITIAL_PASSWORD` (`bootstrap.adminInitialPassword`) rotates the V3 seed admin's password at startup - idempotent: only
  applied while the admin still has the seed hash, so an admin-chosen password is never overwritten. Before rotating in production,
  bootstrap rejects the known `changeme`/`CHANGE-ME` values and applies the normal account password length and bcrypt byte limits.
  Covered by `BootstrapTest`; seed-mutating tests restore state via `TestSeedState.restoreSeedAccounts()` (`TestEnvironment.kt`).

### Everything development mode relaxes

The k8s overlay `k8s/local/front-door.yaml` and compose run it; each item is the code's own switch on `developmentMode`:

- no HTTPS redirect and no HSTS;
- `/openapi` and the Swagger UI exposed, with the inline-script CSP exemption on `/openapi` and its subtree (`plugins/SecurityHeaders.kt`);
- the login per-IP bucket 1000/min instead of 10/min and the password-reset bucket 100/min instead of 5/min (`plugins/RateLimits.kt`);
- the JWT-secret, data-encryption-key and seed-password checks only warn (the `ADMIN_INITIAL_PASSWORD` candidate's burned-value and
  length validation is skipped too - `infra/db/Bootstrap.kt`);
- `mail.transport=log` tolerated, which prints reset links and MFA codes into the log (`kubectl logs`);
- `MAIL_APP_URL` may be `http://` (`infra/mail/Mail.kt`); `MFA_CODE_TTL_SECONDS=0` accepted (`auth/AuthRoutes.kt`);
- the Jira stub host (`jira.stubBaseUrl`) may be a non-https origin and a private address (`jira/Jira.kt`), and the Flow origins of
  `flow.insecureOrigins` may be plain http on a loopback or docker address (`flow/Flow.kt`); production refuses a non-blank value
  of either at boot.

The malformed-key and malformed-`MAIL_APP_URL` refusals hold in any mode.

## JWT model

Files: `auth/Tokens.kt`, `plugins/Security.kt`.

- Login issues an access/refresh **pair**, both carrying `email`, `userId`, a `roles` array, a `typ` claim (`"access"`/`"refresh"`),
  a `credentialRevision` and a random `jti`. The `jwt {}` verifier requires audience (`astrolabe-api`), issuer
  (`http://0.0.0.0:8086/` by default), `typ == "access"`, and a PRESENT `jti` (so both the verifier and `/refresh` reject a
  jti-less token outright).
- **Every authenticated request runs ONE uncached database statement** (`TokenBlocklistService.accessVerdict`; `revoked_tokens` is written by `/logout` and by the refresh rotation, and the revoke path prunes
  expired rows). It reads the token's user row (`role`, `credential_revision`, `marked_as_deleted`) and whether the `jti` is
  blocklisted; the token is accepted only when the account exists and is not deleted, the `jti` is not blocklisted, the
  `credentialRevision` equals the stored one and the `roles` equal the stored role.
- Anything else is a `401` audited `access.rejected` with a `reason`: `user_gone`, `revoked`, `credential_changed`, `roles_changed`,
  and `malformed` for a signed access token lacking `roles`, or whose `userId` (1..4294967295) or `credentialRevision`
  (non-negative) is not an integral JSON number - the same `strictLongClaim` rule as `/refresh`, so `1.0`, `1e0` and a numeric
  string are rejected on both paths (a pre-deploy token, which the SPA silently refreshes). All carry ONE response text ("Access
  token is no longer valid - refresh or sign in again"); the audit event is coalesced to one per user and reason per minute with a
  `suppressed` count, like `rate_limit.exceeded`. Structural rejections (junk, expired, wrong audience/`typ`, no `jti`) stay
  unaudited and never reach the database.
- Nothing is cached: the price is one primary-key read per request (about 1 ms). A role change does NOT bump the credential
  revision, so the SPA's `401` -> `/refresh` succeeds with the new roles. Not compared: the MFA flag and other feature flags (they
  ride the token until the next refresh), lockout, name/email/language. Pinned by `StaleAccessTokenTest`.
- **A lookup that THROWS inside the JWT `validate` block (database unreachable, pool acquire timeout) is an outage, not a bad
  token:** `validate` runs the lookup through `catchingFailures` (`infra/Failures.kt`) and stashes the cause on the call
  (`BlocklistFailureKey` in `plugins/Security.kt`); Ktor turns any throw out of `validate` into a plain challenge, so the challenge
  answers the logged `500` (`respondInternalError`, `plugins/ErrorHandling.kt`) instead of `401` - the SPA reads a `401` as session
  expiry and would sign the user out over a transient outage. A cancelled access-check read (the 15 s statement limit, SQLSTATE
  `57014`) answers the typed `database-timeout` `500` the same way (`StatementTimeoutAnswerTest`, a lock on `users`). A malformed,
  expired, wrong-audience or wrong-`typ` token never reaches the lookup and stays the uniform `401`. Pinned by
  `BlocklistOutageTest`; the `500` is declared on every operation and ignored by the coverage gate (`CROSS_CUTTING_STATUSES`).

Who may call what with a token (guards, the next-request effect of a delete, role or password change): `authorization.md` "Tokens and sessions".

## Token storage and response headers

The SPA keeps BOTH tokens in `localStorage` under `astrolabe.auth.*` (`web/src/api/session.ts` - access, refresh, roles, userId,
disabledFeatures and a random session identity; no password is ever persisted; everything else in localStorage is view state). A
deliberate trade-off: any script running on the origin can read the REFRESH token, a renewable session unbound to device/IP - so
the real control is keeping foreign script out (no CDN scripts, no `unsafe-inline` for scripts - Vite bundles everything
same-origin, fonts included; no `dangerouslySetInnerHTML`/`eval` sinks, currently zero). Moving tokens to httpOnly cookies would
trade this for CSRF machinery - revisit only with that full picture. The refresh token's lifecycle is "Refresh replay grace".

**The headers** (`plugins/SecurityHeaders.kt`, installed unconditionally, pinned by `ServerTest`):

- a strict CSP: `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `object-src 'none'`, `base-uri 'self'`,
  `frame-ancestors 'none'` (the whole string is pinned verbatim); `'unsafe-inline'` for styles is deliberate - Mantine's style
  props/CSS variables render inline `style` attributes and runtime `<style>` tags, and the app uses `style={{}}` itself - a STYLES-only concession;
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()` (also pinned verbatim);
- production mode only (`plugins/Http.kt`): `Strict-Transport-Security` (`max-age=31536000; includeSubDomains`, pinned by
  `ServerTest`'s production-mode boot behind `http.behindProxy` with `X-Forwarded-Proto: https`; absent in development);
- every `/api/` JSON and problem+json answer carries `Cache-Control: no-store` (`plugins/Http.kt`'s `CachingHeaders`, pinned by
  `ServerTest` together with the unchanged caching of the SPA's static assets), so per-user data never lands in a browser or proxy
  cache - the `200`/`304` of a validator-answering view GET adds an `ETag` to the same `no-store` ("Caching");
- `text/html` (index.html and every SPA deep link answered with it) carries `Cache-Control: no-cache` (revalidate every time, so a
  deploy's new hashed asset names are never masked by a stale shell; the SPA's deploy check re-reads this shell for its
  `astrolabe-build` meta, which holds the commit the login page already prints and nothing else), while the content-hashed CSS/JS
  keep `max-age=86400`;
- the `Server` header is the fixed generic `astrolabe` (`install(DefaultHeaders) { header(Server, …) }` in `Http.kt`, never Ktor's default `Server: Ktor/<version>`); pinned in `ServerTest` (no `Ktor` in it).

**The Swagger UI is the ONLY CSP exemption** (it bootstraps with inline script/style). It applies only when `http.exposeOpenApi` is
on (`Application.exposesOpenApi()`, the same definition that mounts the UI: the property when set, else development mode) AND the
path is exactly `/openapi` or starts with `/openapi/`. With it off - production by default - `/openapi`, `/openapi/x` and look-alikes
such as `/openapiX` are ordinary paths (the SPA catch-all answers them with `index.html`) and carry the full CSP. The exempt paths
still get the non-CSP hardening headers. Pinned in `ServerTest`.

## Refresh replay grace

`POST /api/v1/refresh` verifies the presented refresh token (signature, issuer, audience, a PRESENT `exp`, `typ`, a present `jti`,
not blocklisted, the user still active, `credentialRevision` current) and then CLAIMS it: an atomic `INSERT .. ON CONFLICT DO
NOTHING` of its `jti` into `revoked_tokens` (until the token's own expiry; `TokenBlocklistService.revokeIfAbsent`, pinned by
`TokenBlocklistRotationTest`), after which a fresh access/refresh pair is minted. Only the claim is atomic; delivery of the response
is not, so of any number of concurrent calls with one token exactly one inserts the row (`CLAIMED`) and the rest are decided by the
grace.

- **Replay grace** (`security.refresh.replayGraceSeconds`, `$REFRESH_REPLAY_GRACE_SECONDS`, default 60, 0 = strict one-time use): a
  `/refresh` response can be lost after the claim committed (the SPA's 30 s deadline, a dropped VPN, a reload mid-flight), leaving the
  client holding the already-retired token. So a replay of a token THIS instance rotated less than the grace ago is answered with
  another fresh pair (audit `refresh.replay_grace`, `userId`) instead of a `401` that would sign the user out; the same grace answers
  the loser of two tabs refreshing at once (the rotation is recorded inside the claim's transaction, before its commit). One token
  gets at most 2 such re-mints (`MAX_GRACE_REUSES`); after that, or after the window, a replay is rejected.
- **The trail tells replay from logout:** outside the grace, a replay of a rotated token the instance still remembers is a `401`
  audited `refresh.rejected reason=replayed`; a token blocklisted by logout (or whose rotation is not remembered) is `reason=revoked`.
- **The rotation records** (`auth/RefreshRotations.kt`, `RefreshRotationsTest`) are in memory, per instance and capacity-bounded at
  10,000: when full, expired or out-of-grace records are evicted first and, if it is still full, the NEW record is dropped. A restart,
  or a dropped record, loses them and the behaviour falls back to strict.
- **A logout that REACHES the route body ends the grace:** it drops every rotation record of the access principal's user and of the
  presented refresh token's own user (`TokenBlocklistService.forgetRotations`), so a copy of a recently rotated token cannot mint
  after sign-out and its replay is `reason=revoked` (it also ends the grace of that user's other devices, whose next lost-response
  retry then signs out: strict, never lax).
- **`POST /api/v1/logout`** revokes the access token it is called with and the one refresh token the client sends in the body
  (best-effort; both jtis go to the blocklist); it does NOT end other pairs of the same user. It sits behind `authenticate {}`, so it
  needs a valid ACCESS token: on a `401` the SPA's `logout()` (`web/src/api/auth.ts`) exchanges the captured refresh token for a new
  pair without touching the already-cleared local session (`refreshPairDetached`) and calls `/logout` again with the NEW pair; if
  that refresh fails the sign-out stays local only and the refresh token lives until its own expiry (<= 1 h). A direct API caller
  that logs out with an expired access token gets the plain `401` and revokes nothing. Known limitation: a refresh and a logout
  racing within the same few milliseconds can leave the freshly minted pair unrevoked, bounded by the refresh TTL.
- **The accepted cost of the grace:** a stolen token replayed within the grace of its legitimate rotation also gets a pair, at most
  twice (the window is short, the replay is audited and a logout ends it). There is deliberately NO family-wide revocation and no
  "sign out everywhere": a replay outside the grace does not end the live chain, and a stolen token that refreshes FIRST makes the
  victim's next refresh the rejected replay (the victim is signed out and the trail shows `replayed`).
- **What ends what:** the access token a rotation supersedes is not revoked - it stays valid until its own expiry (<= 15 min; only a
  logout blocklists one, and the per-request check ends it on any delete, role change or password change). What ends every
  outstanding refresh token of a user is a password change/reset/bootstrap rotation (the `credential_revision` bump) or an admin
  deleting the account; an idle session also ends at the refresh TTL. The cost is one `revoked_tokens` row per refresh. The SPA
  copes with two tabs sharing one session (`web/src/api/http.ts`, `web-internals.md`).

## Caching

**A settled decision (the owner chose `no-store`).** Every `/api/` answer is `Cache-Control: no-store`. Ten view GETs answer through
a validator: the plan, home, team-load, dependencies, roadmap, programs, project, team, baseline and Jira-links views. The two
deviation views do not: their `connections[].status.nextPollAt` is the read's own instant while a poll is due.

- **The mechanism** (`ApplicationCall.respondRevalidated(userId, body)`, `plugins/ResponseValidators.kt`): it renders the document
  with the application's one `Json` (`ApiJson`; always `application/json` in UTF-8, deliberately not content-negotiated, so
  `Accept-Charset` does not change it), offers `W/"<base64url sha256>"` of **the caller's user id, a line feed and that text**, and
  answers `304` (no body) when `If-None-Match` lists it (weak comparison, a list, or `*` once the view succeeded), else the very
  text it hashed. It writes `ETag` plus ONE `no-store` only when the call really ends as a `200`/`304`. Nothing lands in a browser
  or proxy cache; the `304` serves a client that sends `If-None-Match` itself and keeps the document in its own memory.
- **A hash of the answer cannot go stale:** whatever changes the document changes the tag, with no list of inputs to keep complete
  (`ViewValidatorInputsTest` walks the cases; the ledger is `planning-model.md` "View validators"). The price: a `304` saves the
  transfer and its compression, NOT the view's own work.
- **Cross-user safety rests on three rules:** authentication, the parameters and the view's own `404`/`400` all run BEFORE any
  validator logic (an unauthenticated or refused request is never a `304` and carries no tag, so a `304` is never a way to probe for
  data); the user id is in the hash (one login's tag matches nothing of another's, even for a document identical for every caller);
  and a `problem+json` response is always `no-store` with no validator.
- **The SPA is the client** (`web/src/api/revalidate.ts`; its seven rules are `web-internals.md` "`revalidate.ts`"): memory only, a `304`
  answered with a fresh parse of the text that tag came with, never with query data or an optimistic state.
- **The rejected alternative** was `private, no-cache` + `Vary: Authorization` + a logout `Clear-Site-Data: "cache"`, which would
  leave response bodies on disk between logins on the same profile (best-effort clearing only).
- Cross-origin deployments (`CORS_ALLOWED_HOSTS`): the CORS plugin allows `If-None-Match` and exposes `ETag`, both or neither.
  Ktor's `ConditionalHeaders` stays uninstalled. Over Netty a `304` carries `Content-Length: 0` (Flow's recorded deviation from RFC
  9110 section 8.6; `ViewNotModifiedWireTest` pins it).

## Login

### Timing equalizer

`auth/AuthRoutes.kt` + `TIMING_EQUALIZER_HASH` in `auth/Passwords.kt`: an unknown email pays a full, discarded bcrypt verify against a
fixed cost-12 hash so its 401 takes as long as a wrong password's - without it, response timing is an account-enumeration oracle
(the reset path equalizes via async processing; login equalizes in-line).

### Per-account lockout

`auth/LoginThrottle.kt`, wired in `configureAuthRoutes`.

- After `security.lockout.threshold` (default 5, `$LOGIN_LOCKOUT_THRESHOLD`) consecutive failures for one submitted email, `/login`
  answers `429` for `security.lockout.durationSeconds` (default 900, `$LOGIN_LOCKOUT_DURATION_SECONDS`) - even with the correct
  password, and regardless of whether the account exists (no enumeration signal). A success resets the counter.
- The key is a fixed-size digest of the canonical submitted identity (`loginIdentityKey`, which folds through `canonicalEmail`:
  "Accounts and the canonical email"), so retained key size is bounded even for malformed login input; oversized identities are also
  digested in audit fields instead of logged in full.
- The in-memory, per-instance store (the app runs ONE replica - `ci.yml` `k8s-static` pins it; a restart resets the throttle) has a
  hard `security.lockout.maxTracked` limit (default 10,000, `$LOGIN_LOCKOUT_MAX_TRACKED`): expired state is reclaimed through an
  expiry index, but fresh counters and active locks are never evicted to admit a new identity. At capacity, an untracked identity
  receives an audited `429` before password verification, so saturation cannot bypass the account throttle; tracked identities can
  still finish their normal flow. It complements the per-IP bucket, which rotating hosts sidestep.
- The 429 is **thrown** (`TooManyRequestsException`), never `respondProblem`ed directly - StatusPages' generic 429 status handler
  rewrites any non-StatusPages 429, so only the exception path keeps the specific detail. The SPA shows a neutral temporary sign-in
  limit for either 429 cause.
- Tests: `LoginThrottleTest` (unit, injected clock) + `LoginLockoutTest` (route).

## Self password change throttle

`users/PasswordChangeThrottle.kt`, wired in `configureUserRoutes`. A stolen session could otherwise grind the owner's current
password through `PUT /users/{id}/password`. The self change (never the admin reset of another user) counts wrong or missing current
passwords per USER ID in a SEPARATE `LoginThrottle` instance fed by the same `security.lockout.*` settings (5 attempts, 15 minutes,
`maxTracked`): the locked attempt answers `429` (thrown `TooManyRequestsException`) even with the correct current password, and a
thief can lock only this endpoint, never the owner's `/login` (different instance, different key).

- **Order** (after the per-user `password-change` bucket, which answers first): `403` -> `429` -> `400` (body, then the new
  password's rules) -> `403` (wrong current). The new password is validated BEFORE the current one on purpose, so a refused new
  password is not an oracle for the current one (`authorization.md`). Revocation of other sessions is unchanged (the
  credential-revision bump).
- **What clears the counter:** a verified current password, an admin reset of that user, a completed emailed password reset (both
  end every session and lift even an ACTIVE lock, `LoginThrottle.clear`), the window expiring, or a restart.
- **The trade-off, plainly:** someone holding a stolen session can keep this lock active for as long as that session lives, so the
  owner cannot change their password from the SPA meanwhile. The owner's exits are the email reset (503 when
  `MAIL_TRANSPORT=disabled`, the k8s default) or an admin reset; either ends every session. The guessing budget: `/login` has its own
  counter, so a thief gets 10 guesses per 15 minutes across both endpoints (5 + 5). A stolen ADMIN session makes this throttle moot
  (an admin resets any password without the current one).
- **Audit:** `password.change_denied` per attempt (bounded by the lock), `password.change_locked` once,
  `password.change_rejected_locked` coalesced with `suppressed`, `password.change_capacity_rejected` (`observability.md`).
  In-memory and per-instance, like the login lockout. Pinned by `PasswordChangeTest` and `PasswordChangeThrottleTest` (including
  that `/login` still answers 200 while the change is locked).

## Self-service password reset by confirm link

Files: `auth/PasswordResetRoutes.kt`, `auth/PasswordResetService.kt`, V8. SPA: "Forgot password?" on `/login` ->
`/reset-password`; the emailed link opens `/reset-password/confirm`.

### The request and the grants

- The public `POST /api/v1/password-reset` takes `{email}` and answers a uniform `202` for any well-formed request - the lookup,
  grant issuance and email delivery run **asynchronously** after the response (uniform latency, no existence oracle), and the
  request **changes nothing**: no password, no session. An unknown or soft-deleted account (`findWithIdByEmail` filters active rows)
  sends nothing.
- Each link carries a 256-bit `SecureRandom` token (43-char base64url); only its SHA-256 digest is persisted in
  `password_reset_tokens` with the user id, the **account snapshot** (`credential_revision` AND `email`) and the expiry. Lookup is
  SQL equality on the digest, so no constant-time compare is needed (OWASP Forgot-Password cheat sheet). The lifetime is
  `security.passwordReset.tokenTtlSeconds` (`$PASSWORD_RESET_TOKEN_TTL_SECONDS`, default 900, boot-validated 1..3600).
- **Several links may coexist** - a newer request never revokes a usable one, or anyone typing an address into the form could kill
  the owner's link; a failed delivery revokes only the grant it just minted (`password_reset.send_failed`); expired rows are pruned
  on every issue.
- **An account holds at most 5 unexpired grants** (a constant in `PasswordResetService`, counted under the user-row lock so
  concurrent requests cannot slip past it): at the cap `issue` mints nothing, the async worker sends no email and audits
  `password_reset.capped` (userId only), and the request route still answers `202` (no oracle). Earlier links stay valid. This bounds
  the nuisance of the unauthenticated form to at most 5 live links per lifetime per account, on top of the one-request-per-minute
  throttle. The async task that finds the account moved between its lookup and the grant insert audits
  `password_reset.stale_account` (userId) and sends nothing.
- A grant dies on **use** (confirming deletes every grant of that user), a **password change** (the captured `credential_revision`
  no longer matches), an **email change** (the captured `email` no longer matches; the credential revision moves only on password
  changes and must stay that way), an account **soft delete** and **expiry**; a role change does not invalidate it.
- The email renders through `LocalizedText` in the RECIPIENT'S stored language (V1 `users.language`, EN fallback); no email carries
  a password.

### The link and the confirm step

- The link is `<mail.appUrl>/reset-password/confirm#token=…`. The token sits in the URL **fragment**, which never reaches the
  server, its access logs or `Referer`; the SPA strips it from history and keeps it in component memory, and loading the page
  consumes nothing (there is deliberately no token pre-check endpoint - an invalid token is learned at submit).
- The origin is `mail.appUrl` (`$MAIL_APP_URL`), **configured, never derived from the request `Host`**, validated at boot in any mode
  ("The startup checks"). A **blank** value is allowed: the request route then answers `503` ("set MAIL_APP_URL") and boot logs ONE
  `warn` when the transport is not `disabled`. `503` also when the deployment has no outbound email (`MAIL_TRANSPORT=disabled`).
- Public `POST /api/v1/password-reset/confirm` takes `{token, password}`. The grant is checked FIRST (`isUsable`, before any bcrypt:
  a junk token never costs a hash; for the PASSWORD rules the 401 wins over a 400 - a body that fails to decode is a 400 first),
  then `validatePassword` (a refused password is a `400` that does **not** consume the grant), then
  `PasswordResetService.complete` does consumption, the password write (`updatePasswordInTransaction`, conditional on the captured
  revision) and the deletion of every sibling grant in **one transaction**, under a `FOR NO KEY UPDATE` lock of the user row
  (persistence.md "Row locks vs. FK locks"), so competing confirmations (across instances too) have exactly one winner.
- An unknown, malformed, expired, used or stale grant is one uniform `401` (`password_reset.rejected`). Success is `204` with **no
  auto-login**: the `credential_revision` bump signs every other session out through the per-request access check and kills pending
  refresh tokens and MFA challenges, while MFA stays as it was, so the next login still asks for the code. A best-effort localized
  notice ("your password was reset, sessions signed out"; no token, no password) is emailed after the response; its failure
  (`password_reset.notification_failed`) cannot undo the reset. A confirmed reset does **not** clear the per-account lockout
  (in-memory, at most 15 minutes, per instance). A lost 204 can make a retry answer `401`: sign in with the chosen password or
  request another link.

### Throttling and tests

- Per submitted email: one request per `security.passwordReset.minIntervalSeconds` (default 60,
  `$PASSWORD_RESET_MIN_INTERVAL_SECONDS`), uniformly for existing and unknown addresses (`auth/PasswordResetThrottle.kt`,
  in-memory/per-instance like the lockout, keyed by `canonicalEmail`), with the hard `security.passwordReset.maxTracked` limit
  (default 10,000, `$PASSWORD_RESET_MAX_TRACKED`: elapsed cooldowns are reclaimed, a fresh one never evicted; saturation rejects a
  new identity with an audited `429` before any worker starts). The per-IP `password-reset` and `password-reset-confirm` buckets:
  "Per-IP buckets".
- `Cache-Control: no-store` already rides every `/api/` JSON and problem+json answer (StatusPages' 429s included); the bodiless
  `204` has nothing to cache. The development `log` mail transport prints the link: it must stay inaccessible outside a local demo
  (production refuses it).
- Pinned by: `PasswordResetServiceTest` (injected-clock expiry, the single-use race, staleness, the 5-grant cap, and a completed reset followed by an admin password write: both succeed, the admin's password is final), `PasswordResetConfirmationTest`
  (the confirm route, its own bucket, the `mail.appUrl` boot contract), `PasswordResetTest` (the full link roundtrip), `PasswordResetThrottleTest`,
  `LocalizedEmailTest`.

## Rate limits

`plugins/RateLimits.kt` installs every bucket and owns the bucket names. Every bucket, per-IP or per-USER, answers an over-limit call
with the generic `429` problem, `Retry-After` and the coalesced `rate_limit.exceeded` audit event.

| Bucket | Key | Limit | Config / note |
|---|---|---|---|
| `login` | IP | 10/min production, 1000/min development | `security.rateLimit.loginPerMinute`, `$LOGIN_RATE_LIMIT_PER_MINUTE` |
| `refresh` | IP | 30/min both modes | `security.rateLimit.refreshPerMinute`, `$REFRESH_RATE_LIMIT_PER_MINUTE` |
| `password-reset` | IP | 5/min production, 100/min development | `security.rateLimit.passwordResetPerMinute`, `$PASSWORD_RESET_RATE_LIMIT_PER_MINUTE` |
| `password-reset-confirm` | IP | 10/min every mode | not configurable |
| `mfa` | IP | 10/min every mode | hardcoded |
| `jira-test` | IP | 10/min default, every mode; bounded `1..100` | `security.rateLimit.jiraTestPerMinute`, `$JIRA_TEST_RATE_LIMIT_PER_MINUTE` |
| `flow-test` | IP | 10/min default, every mode; bounded `1..100` | `security.rateLimit.flowTestPerMinute`, `$FLOW_TEST_RATE_LIMIT_PER_MINUTE` |
| `ready` | IP | 60/min both modes | `security.rateLimit.readyPerMinute`, `$READY_RATE_LIMIT_PER_MINUTE` |
| `telemetry` | user | 30/min every mode | `RateLimits.TELEMETRY` |
| `jira-bind` | user | 30/min every mode | `RateLimits.JIRA_BIND` |
| `jira-import` | user | 5/min every mode | `RateLimits.JIRA_IMPORT` |
| `password-change` | user | 10/min every mode | `RateLimits.PASSWORD_CHANGE` |
| `sync-run` | user | 10 per fixed 60 s window, every mode | no config key |
| `schedule-proposal-save` | user | 10/min every mode | `RateLimits.SCHEDULE_PROPOSAL_SAVE` |
| `schedule-proposal-run` | user | 30/min, run + accept | no config key |

### Per-IP buckets

- **`login`**: blank config **follows the mode** and an explicit number pins it in either mode (the `http.exposeOpenApi` idiom).
  Development is lifted because the e2e suite drives its logins from one host and would otherwise sleep out the bucket; **the
  per-account lockout is the actual brute-force defence and is identical in both modes**. `RateLimitResponseTest` and `LoginTest` pin
  the value to `10` explicitly, since tests run in development mode.
- **`password-reset`**: blank follows the mode. **`password-reset-confirm`** is the confirm step's own bucket (the MFA idiom).
  **`mfa`** guards `POST /login/mfa`.
- **`ready`**: the anonymous `GET /api/v1/ready` (one pooled DB round trip per call): the kubelet probes it every 5 s (12/min) and the
  e2e global setup every 2 s (30/min), so probers stay far under it; `/api/v1/health` does no I/O and has no bucket.
- **`jira-test`** (Test connection and Peek): blank = the code default 10 in every mode, bounded `1..100` (each call fans out to
  Jira; anything else refuses boot). The e2e stacks pin 30 (`docker-compose.yaml`; the OrbStack overlay `k8s/local/front-door.yaml`,
  an `optional` ConfigMap key absent from the production ConfigMap, which `k8s-static` pins). Pinned by `RateLimitResponseTest` and
  `NumericConfigBoundsTest`.
- **`flow-test`** (both Flow Test-connection routes; its OWN bucket, so a Flow test never spends a Jira one): the same idiom and the
  same e2e pin of 30. The bind, the capacity preview and the capacity apply make no Flow call and ride no bucket. Pinned by
  `RateLimitResponseTest`, `NumericConfigBoundsTest` and `FlowTestConnectionTest`.

### No budget headers

Every bucket speaks `Retry-After` (the wait rounded UP to whole seconds, 1..60, as Ktor's default) on its `429` and nothing else:
Ktor's default `X-RateLimit-Limit/-Remaining/-Reset` on admitted answers is never added, by the one `retryAfterOnly()` policy that
both registration loops in `plugins/RateLimits.kt` apply (a new bucket inherits it; API-RATE-001, the spec declares none).
`RateLimitHeadersTest` walks every registered bucket (`perIpBuckets()`, `perUserBuckets()`) plus real routes.

### Per-user buckets

- **`telemetry`** - keyed by the verified user id, not the client IP, so a NAT'd office is not one bucket - for
  `GET /api/v1/telemetry/current` and `/history` (ADMIN only): `configureTelemetryRoutes` mounts
  `rateLimit(RateLimitName(RateLimits.TELEMETRY))` once INSIDE `authenticate {}` around both reads (`TelemetryRoutesTest`). The panel
  polls `current` once a minute; each call is a few `ops` aggregations, so the bound is for a runaway client. Audit: bucket
  `telemetry`, `byUserId`.
- **`jira-bind`** - for `POST /api/v1/integrations/jira/bindings` ONLY (the reads and the unbind are database-only):
  `jira/JiraBindingRoutes.kt` mounts it inside `authenticate {}` around the POST. Any owner of a plan node can trigger a bind, which
  makes up to two outbound calls with the connection's stored token, so the bound protects the shared Jira quota and caps the
  enumeration the pre-flight answers (`authorization.md` "What a node owner can learn"). It runs BEFORE the handler and so before the
  guard: a request that would be 404, 403 or 400 spends a token too, and an over-limit caller gets `429` whatever the request would
  have answered (`JiraBindingTest`). Not `jira-test`: that one is per IP and shared with Test connection and Peek (ADMIN-only).
  Audit: bucket `jira-bind`, `byUserId`.
- **`password-change`** - for `PUT /api/v1/users/{id}/password` (`users/UserSettingsRoutes.kt`): it bounds the CPU a burst from ONE signed-in
  account can burn, because the lock preflight is not atomic with recording a failure (parallel requests each pay a cost-12 bcrypt
  verify before the lock trips; the guess budget itself holds). Mounted on the route node, so it runs before the guard, the lock
  preflight, the body and the bcrypt verify: an over-limit caller gets `429` whatever the request would have answered, even with the
  correct current password (`PasswordChangeBucketTest`). Ten because a human changing a password needs a few tries; the 5-attempt
  wrong-current lock is the guess defence, this bucket is not. **Keyed by the CALLER (the JWT `userId`), never the path id**: one
  bucket covers the self change and the admin reset (the route cannot tell them before the guard), so an admin resetting someone
  else's password spends the admin's own tokens and the target's attempts can never starve it. The lock's own 429 keeps its distinct
  events, carries no `Retry-After` and has the problem `type` `urn:astrolabe:problem:password-change-locked` (the bucket's is
  `about:blank`), which is how the SPA tells "locked" from "slow down" without reading prose (`ChangePassword.test.tsx`;
  `PasswordChangeTest` pins the type). Audit: bucket `password-change`, `byUserId`.
- **`sync-run`** (Ktor refills the whole window at once, so a burst across a window edge can admit up to 20) - ONE bucket for both
  kinds (a Flow press and a Jira press count together) - for `POST /api/v1/integrations/sync/runs` (`sync/SyncRoutes.kt`, ADMIN
  only). The one unfinished run per connection (`uq_sync_runs_running`) bounds the concurrency, and each press may add up to the probe
  cap (100, `GONE_PROBE_CAP`) of by-id reads, so the RATE is bounded per signed-in user. It wraps ONLY the POST on the route node,
  inside `authenticate {}`, so it keys on the verified `userId`, answers `429` + `Retry-After` BEFORE `requireAdmin` (a refused press,
  a 403 or a 400 spends a token too) and emits no `sync_requested`; the list GET and the scheduler's runs ride no bucket. **A run
  outside the bucket, by decision:** a connection or mapping edit, or a passing stored Test, makes the scheduler run that connection
  at its next tick (`SchedulePolicy`: the connection's `changedAt` is newer than its newest run); that run is ADMIN-only (so is the
  edit), at most one per tick per connection, and a scheduled run re-asks an answered readable gone item at most once per
  `jira.censusHours`. Tests: `SyncRunBucketTest`.
- **`schedule-proposal-run`**: per user, ahead of body and guard; ONE bucket for the run and the accept (both run the kernel, the accept under the lock via the look-again path); the check has none. Rate, not concurrency (`BACKLOG.md`).

### The Jira import bucket

**`jira-import`** (`RateLimits.JIRA_IMPORT`, per verified user id): ONE bucket of 5 calls a minute for `POST .../connections/{id}/import-preview` and the apply, ahead of the guard (a request that would be `404`, `403` or `400` spends a token; over the limit is `429` whatever it would have answered). Its bounds (the 170 s browse, the by-id reads, concurrency and permits, the rooted budget, the query rules) are `jira-sync.md` "Import".

## Email MFA

Opt-in; files `auth/MfaChallenges.kt` + `auth/MfaEmail.kt`, wired in `configureAuthRoutes`. SPA: the Login card's second step
(`PinInput`, `auth.mfa*` keys).

### The flag and the challenge

- A per-user second factor behind the `MFA` feature flag - **the one inverted-default flag**: `V5` seeds every existing user as
  MFA-disabled and `UserService.create` inserts the disabled row for every new user (admin create and test seeds both funnel through
  it), so MFA is OFF until an admin removes the row via the features PUT (the per-user editor or the `/feature-flags` bulk screen;
  mind the wholesale-replace semantics - a PUT whose disabled set omits `MFA` ENABLES it, including the "empty array re-enables
  everything" idiom).
- With MFA enabled, `POST /login` with correct credentials normally answers
  `200 MfaChallengeResponse {mfaRequired, challengeId, expiresAt}` instead of tokens (the branch runs AFTER `verifyPassword`, so
  nothing about enumeration or lockout changes; `login.success` is deliberately NOT emitted). A 6-digit code (`generateMfaCode`,
  `auth/Passwords.kt`) is held in the in-memory challenge store (`security.mfa.codeTtlSeconds` default 300 `$MFA_CODE_TTL_SECONDS`,
  `security.mfa.maxAttempts` default 5 `$MFA_MAX_ATTEMPTS`; per-instance like the throttles - a restart just means signing in again) and emailed in the user's stored language
  (V1 `users.language`, EN fallback).
- The hard `security.mfa.maxTracked` limit (default 10,000, `$MFA_MAX_TRACKED`) first drops expired challenges, then rejects new
  issuance with an audited `429` at capacity; existing codes remain verifiable and no rejected code is emailed. A failed or cancelled
  delivery discards its challenge so a retry can use that slot; an exhausted, verified, discarded or expired challenge frees its
  slot. Delivery failures are logged by exception class only (`MFA code email delivery failed (<Class>)`).

### The per-account limit

`security.mfa.maxLivePerAccount` (default 3, 1..100, `$MFA_MAX_LIVE_PER_ACCOUNT`): a new password-correct login gets a fresh code
(unless the shared store is genuinely full: the global `429`). Under the store lock `issue` prunes expired entries, drops the
account's entries minted under an OLDER credential revision (they can never verify; entries of a NEWER revision are never touched,
so a late login that read an old revision cannot evict the owner's current challenge), and if the account still holds the limit of
the same revision drops its OLDEST by issue order (a sequence number, not the clock) until one slot is free; only then does the
global `maxTracked` check run, so an account at its limit is never refused by a full store. The displaced code stops working; a late
`discard` of an evicted id is a no-op. The `login.mfa_challenge` audit event carries `evicted` (a count; never codes or challenge ids).

- The limit bounds the live codes per account and the memory, and stops one leaked password from filling the shared store. It does
  NOT bound mails or guesses per account; those stay limited by the per-IP buckets.
- **Guessing:** at the `mfa` bucket's 10/min per IP, each guess hits one challenge's 6-digit code (1 in 10^6) and
  a challenge dies after `maxAttempts` (5) wrong guesses, so one IP gets about 10 guesses a minute = 1e-5 per minute = about 1.4% per
  day (14,400 guesses) against a code space of 10^6, minting a fresh challenge every 5 guesses within the login bucket; more IPs
  scale it linearly, and nothing bounds it per account (the accepted per-IP posture).
- **Accepted cost:** someone who knows the password can invalidate the owner's pending code by logging in repeatedly; the owner signs
  in again for a fresh one, and every such login still emails the owner, which is the signal. Sustained (a login every 6 s from ONE IP
  within the production 10/min bucket) it evicts the owner's fresh code within about 18 s (3 further logins at the default limit), so
  the owner's "sign in again" can lose the race repeatedly. Eviction happens before the delivery outcome, so a failed mail can cost
  the oldest code with no replacement.
- **The recovery** is a password reset, which kills the leaked password: the email reset flow does NOT require the second factor (the
  emailed single-use link is the proof; `PasswordReset*.kt` has no MFA reference) and its confirm bumps the credential revision,
  which also invalidates every pending challenge. Where mail is disabled the reset request answers `503`, which leaves the ADMIN
  reset (`PUT /users/{id}/password`).
- MFA failures do NOT feed the login lockout (`LoginThrottle` only counts password failures). A code verifies only with the
  `challengeId` of its own login, so the wrong-code message says to use the code emailed for THIS sign-in or sign in again (Back
  loses the `challengeId`; no server call is made on Back; "the newest email" would be wrong with a second tab or device).

### The code step

`POST /api/v1/login/mfa` `{challengeId, code}` (own per-IP bucket `"mfa"`, hardcoded 10/min in every mode) exchanges it for the
ordinary `LoginResponse` - one fresh `userService.read` first (the `/refresh` precedent: current roles/flags; a user deleted in
between -> the uniform 401 `user_gone`). Every failure mode (unknown/expired/wrong code/attempt cap) is a **uniform 401**, reasons live
only in the `login.mfa_failure` audit event; challenges are single-use and bound to the credential revision verified at the password
step; a subsequent password change/reset invalidates the pending challenge. **Mail-less deployments fail closed**: on
`MAIL_TRANSPORT=disabled` an MFA-enabled login answers `503` (`login.mfa_unavailable`) - don't enable MFA flags on the k8s default
`disabled` transport; the features PUT keeps working, so an admin can always flip the flag back. Tests: `MfaChallengesTest` (pure
store) + `MfaLoginTest` (route matrix); e2e `mfa.spec.ts` drives the emailed code through Mailpit.

## Swagger gate

`plugins/Routing.kt`: `/openapi` (UI + spec) is served only in development mode, or when `http.exposeOpenApi`
(`$HTTP_EXPOSE_OPENAPI`) is explicitly `"true"` - blank follows the mode, `"false"` hides it even in dev (the mount lives in
`configureRouting`; the CSP exemption follows the same condition). Bearer auth cannot protect a browser-loaded UI (page loads carry
no `Authorization` header), hence a gate rather than `authenticate {}`.

## Accounts and the canonical email

**Accounts are admin-managed.** There is no self-signup: administrators create accounts at `/users/new`. The initial password is
generated CLIENT-side (`web/src/utils/password.ts`, 96 bits) and shown to the admin exactly once in the reveal modal - the server
stores only the bcrypt hash and no response ever carries plaintext; users rotate it via the Change password page (the existing
`PUT /users/{id}/password` rules). Deletion is the soft-delete convention plus two guards: no self-delete (403) and the last active
administrator can be neither deleted nor demoted (409).

**Canonical email identity.** Emails are folded to `trim().lowercase()` (`canonicalEmail` in `infra/validation/Email.kt`, shared with
the Jira connection's account email) at EVERY entry point - login and `findWithIdByEmail` itself (defense-in-depth), and every
create/update/import - so one mailbox is one account and a padded/case-variant login matches. The V1 partial unique index stays
byte-wise (all writes are canonical). Both throttle keys fold through the same function: `loginIdentityKey` (the sha256 of the
canonical form) and `PasswordResetThrottle`'s key (the canonical form itself) both call `canonicalEmail`, so a raw address and its
canonical form share one lockout bucket and one reset cooldown (`auth/ThrottleKeyFoldTest`).

## Request limits

### Body ceiling

`RequestBodyLimit` (installed in `plugins/Http.kt`, `MAX_REQUEST_BODY_BYTES` = 10 MiB) rejects oversized bodies with a 413 problem
(mapped in `plugins/ErrorHandling.kt`) before any receive/validation work - a memory-DoS backstop, not a business rule; field-level
`maxLength` validation rejects oversized values far earlier on ordinary payloads. Declared in the spec on every body-taking
operation and covered by the one `PayloadValidationTest` case.

### Slow requests

`ktor.deployment.requestReadTimeoutSeconds` (`$REQUEST_READ_TIMEOUT_SECONDS`, default **60**, `0` = off). `configureHttp` refuses a value
outside 0..3600 at boot in every mode, naming the key; a non-numeric one fails earlier, inside `EngineMain`'s own `toInt()` (a `NumberFormatException` without the key). No
production-only rule. `EngineMain` reads the key, so it exists only on the real Netty engine, never under `testApplication`.
`RequestReadTimeoutTest` boots the real app through `main.kt`'s `createServer` (`EngineMain.createServer` plus `rearmReadTimeout`)
and speaks raw HTTP; what it pins is marked *tested*, the rest was read from the Ktor 3.6.1 bytecode (`NettyHttp1Handler.exceptionCaught`).

- *Re-armed per request:* Ktor's own one-shot handler never cut a connection again once it had idled past the timeout, so `main.kt`
  installs `RepeatingReadTimeoutHandler` (`plugins/ReadTimeout.kt`; `rearmReadTimeout`): it reports on EVERY firing and closes nothing.
  With the timeout `0` or on HTTP/2 nothing changes.
- *Tested:* an **idle-read gap** that restarts on every inbound read, NOT a total body deadline: a trickling client keeps a request open
  indefinitely (the bounds there are the 10 MiB body ceiling, the DB pool and the route's re-guard under `plan_state`).
- *Tested:* when no byte arrives for the whole interval while a request is open, Ktor writes a `408` (`Content-Length: 0`,
  `Connection: close`, no problem body, written by Netty outside the app pipeline so it is not in the spec) and closes the connection;
  the call is cancelled, `ErrorHandling` treats any `CancellationException` as expected (no 500, no ERROR) and logs ONE INFO line
  `Request timed out waiting for bytes (408): METHOD path` (DEBUG for any other cancellation). An idle keep-alive connection with no
  request open is not closed (closing it would be a separate decision).
- *Bytecode only, untested:* the gap also counts the time a handler runs AFTER the request is fully read (the call stays in
  `activeCalls`), so the value must outlast the slowest legitimate call, a writer queued behind the `plan_state` lock included: such a
  request gets a 408 (and its work is cancelled) once lock wait plus work exceeds 60 s without a byte arriving. Nothing is expected to
  approach that (pool acquire is 10 s; the SPA gives up at 30 s).
- *Statement limit beneath it:* every statement on the application's pool has a 15 s limit, except a transaction with its own budget
  (the telemetry reads) and Flyway (`postgres.statementTimeoutSeconds`, `persistence.md`), so a writer queued behind the lock answers
  the typed `500` long before the browser's 30 s and this 60 s cut.
- Default 60 s = twice the SPA's 30 s request deadline (`web/src/api/http.ts`), the nginx `client_body_timeout` default, and well above
  the pool-acquire wait. The write side is Ktor's own `responseWriteTimeoutSeconds` default of 10 s, not configurable here.

### Payload validation

Convention (API-SEC-003/API-ERR-005). Mutating routes validate payloads up-front and throw `BadRequestException` (-> `400` +
`ProblemDetail`) instead of letting oversized/blank values die in the DB as `500`s. One cross-cutting example: password >=
`MIN_PASSWORD_LENGTH` (10) chars AND <= 71 UTF-8 bytes (`validatePassword` in `users/Validation.kt` + `MAX_PASSWORD_BYTES` in
`auth/Passwords.kt` - **the bcrypt ceiling**: longer input makes bcrypt throw, and the 500-vs-401 split would be an
account-enumeration oracle, so login's `verifyPassword` guards it too). Declare limits as `maxLength` in the OpenAPI spec. Keep new
validators feature-local and enforce them **after** the authz guard (403 wins over 400). Covered by `PayloadValidationTest`.

## Outbound HTTP calls

The SSRF posture. The consumers are the Jira sync (`jira/`) and the Flow sync (`flow/`); every server-initiated HTTP call (a sync, a
webhook, anything) goes through `infra/outbound/`.

### The guard

- `OutboundGuard.kt` `isBlockedAddress` (loopback, site-local, link-local, any-local, multicast, IPv6
  unique-local `fc00::/7`, CGNAT `100.64.0.0/10`, `192.0.0.0/24`, benchmarking `198.18.0.0/15`, "this network" `0.0.0.0/8`,
  reserved `240.0.0.0/4` (the limited broadcast `255.255.255.255` inside it), a NAT64 `64:ff9b::/96` address embedding a non-public
  IPv4, and the whole of the local-use NAT64 prefix `64:ff9b:1::/48`), adding four things: an IPv4-mapped IPv6 address is
  unwrapped to its IPv4 form first, 6to4 `2002::/16` and Teredo `2001:0::/32` are blocked, and so is the deprecated IPv6 `::/96`
  family, IPv4-compatible `::a.b.c.d` included, and the IPv4-translated SIIT range `::ffff:0:0:0/96` whole, never unwrapped (one
  helper each, `isInZeroPrefix96` / `isInSiitPrefix96`, shared with `isNeverAllowed`); all pinned by `OutboundGuardTest`, as defense
  in depth.
- The PRIMARY boundary is a **host allow-list** the caller supplies (a connector allows exactly its provider's API hosts; a
  development-only stub host may be added in development mode and is refused at startup in production, like the
  crypto-key/mail-transport checks).
- `GuardedDns` (an `okhttp3.Dns`) re-checks the allow-list and re-resolves + re-checks addresses on every NEW connection (not once
  per request: the client is long-lived and shared, and pooled connections REUSE an already-checked address); the address rule is an
  injectable `addressAllowed(host, address)` (default `publicAddressesOnly`, i.e. `!isBlockedAddress()`; the lookup is
  all-or-nothing, one refused answer fails it). The client also checks every request's origin (`https` on 443 to an allowed host)
  and refuses a request carrying a caller-set `Host` header; this closes the IP-literal gap (OkHttp never hands a literal host to
  `GuardedDns`) at the transport level.
- The guarded `OkHttpClient` (`guardedOkHttpClient`) sets `Proxy.NO_PROXY`, `followRedirects(false)` (both at the OkHttp engine
  level AND Ktor's own client-side `HttpRedirect` plugin - `followRedirects = false` and the `HttpTimeout` in
  `infra/outbound/GuardedKtorClient.kt` - checking-then-following would defeat the address check either way),
  `retryOnConnectionFailure(false)`, no cookies, no proxy authenticator.
- A consumer layers a **bounded response read** (a byte cap, plus a structural node and depth ceiling checked before a JSON parse,
  so a hostile host cannot cost a heap-sized tree or a `StackOverflowError`) and exponential backoff with jitter on top (`fetch/SourceHttp.kt`).
- Every guard rejection is audited as `outbound.blocked` (scheme + host ONLY - never the full URL, which may embed a token).
  **A DNS failure is NOT a guard rejection:** when the resolver throws `UnknownHostException` or answers with no address for an
  ALREADY allow-listed host, `GuardedDns` throws a plain `UnknownHostException(host)` (never a `BlockedHostException`), audits
  nothing and logs ONE WARN (host only, no stack trace) - no security property is in play, and a lost DNS answer is routine on a
  VPN/forwarding resolver. It is an `IOException`, so a consumer retries it with the normal backoff, and every retry re-runs the
  allow-list check and the resolve-check-connect sequence. The allow-list check runs BEFORE any resolution, so a disallowed host is
  never resolved.
- The primary trust boundary for an upstream API is a scoped, read-only credential, stored encrypted ("Encryption at rest").
- **Pinned by:** `OutboundGuardTest` (no network), `OutboundTransportTest` (a LOCAL socket server proves the response/connection
  release `prepareRequest {}.execute {}`, with a negative control for the old `client.request()` pattern). `DirectSocketFactory`
  (in `OutboundGuard.kt`) refuses every self-resolving `createSocket` overload; its socket never consults the JVM `ProxySelector`, and
  the guarded client connects to exactly the address `GuardedDns` returned. `fastFallback(false)` is a configuration assertion by
  choice.

### The Jira consumer

`jira/Jira.kt` `configureJira`. ONE guarded client (`buildGuardedJiraHttpClient`, the very
function the tests build their client with) serves every connection, closed on `ApplicationStopped`, with:

- `allowedHost = isAllowedJiraHost(host, stubHost, developmentMode)`: `api.atlassian.com`, a genuine `*.atlassian.net` tenant by the
  SAME `JIRA_SITE_URL_PATTERN` + `ATLASSIAN_RESERVED_SITE_LABELS` the connection validation uses (`infra/outbound/AtlassianSites.kt`),
  or in development the stub host;
- `addressAllowed` = `publicAddressesOnly`, plus the stub host in development, judged by the rule of "The Flow consumer"'s insecure hosts (`jiraAddressRule` ->
  `isDevelopmentFixtureAddress`: loopback, or any address outside the never-admitted classes; a docker or private address is
  fine; an IP-literal `jira.stubBaseUrl` is judged by the same rule at boot: an IPv6 literal or a non-canonical numeric
  host such as `2852039166` is refused);
- `schemeFor` = the stub's own scheme for the stub host, else `https` (so `outbound.blocked` never claims a scheme that was not used);
- `originAllowed = isAllowedJiraOrigin` (`https` on 443 to an allowed host, or exactly the stub's origin in development: an
  IP-literal URL, a foreign port or plain http to a tenant is refused and audited);
- no proxy, no redirects, no retry at the OkHttp layer.

**A stored site URL cannot steer the traffic** (`jira-sync.md` "Rules": only the unauthenticated `GET /_edge/tenant_info` goes to the
site, every authenticated call to the `api.atlassian.com` gateway, the stub host in development; the cloud id is validated as a UUID before it is
stored or spliced into a path). A Jira-supplied issue id or key is checked against `^[0-9]{1,20}$` / the key pattern before it joins a
path (the gone probe's stored key: `jira-sync.md` "The gone probe", `JiraGoneProbeRunTest`), and a stored site that no longer has the
genuine tenant shape is refused (`BLOCKED_HOST` row) before any client is built.

**`jira.stubBaseUrl`** (`$JIRA_STUB_BASE_URL`, `http(s)://host[:port]` and nothing else - a malformed value refuses boot in any
mode, naming the key and never the value) reroutes BOTH hosts of a `stub-` site, and no other (`jira/JiraStubRouting.kt`;
`jira-sync.md` "The stub on each stack"). A non-blank value outside development mode refuses startup, so production can never reach one
(`JiraBootTest`: the refusal, and "in production no loopback host is reachable, the stub's included").

**The keys** (`jira.*`; defaults and bounds: `jira-sync.md` "The transport and the gateway") are boot-validated through
`requireConfigInt`/`requireConfigLong`. `jira/JiraHeapFit.kt` refuses the boot when `maxResponseBytes` and `maxConcurrentRequests` do
not fit the JVM's old generation: one big parsed tree (112 B a node, the node ceiling of the cap) + the other in-flight trees below
the 1 MiB lock threshold + every in-flight body + a 96 MiB reserve (the defaults need 174 MiB of the shipped `-Xmx256m -Xmn64m`
JVM's 192 MiB; 16 MiB x 8 is refused; the 112 B and the reserve are measurements, not yet re-measured here).

**Response handling.** The client trims each big response INSIDE the transport's transform (`fields()` and `issueTypes()` return
only the rows the mapping uses), so a parsed tree never outlives its call and the one-big-tree-at-a-time invariant of `SourceHttp`
holds across the probes.

**The token** exists in memory only inside `HttpJiraClient`'s `Authorization` value and the `JiraTestTarget` the connector is handed
(both mask it; `toString` pinned by `SecretToStringTest`); its readers and the decrypt-or-null rule are `sync.md` "A stored token's
life". A `FetchException` message carries the host-and-path endpoint WITHOUT its query string.

**The outbound permit pool of Jira is one for the process** (`jira.maxConcurrentRequests`, the number the heap-fit check sized the
heap on; Flow has its own, bounded by its own tight keys: "The Flow consumer"). A call's deadline clock starts BEFORE it queues for
its first permit, so a saturated pool fails the call `TIMEOUT` instead of parking it for ever. Only the bind carries a `PermitWait`
(`jira.bindPermitWaitMillis`): a bind that cannot get a permit in time answers `502` `BUSY`, so a burst of binds cannot hold an
administrator's Test connection behind them; a preview, a run and a probe set none, so `BUSY` is not in the run code list. Pinned by
`PermitContentionTest` and `JiraBindBusyTest`.

Also pinned by `OutboundGuardTest` (the production-wiring cases against the loopback `JiraStubServer`: `BLOCKED_HOST` after exactly one attempt), `JiraBootTest`,
`JiraClientTest` and `JiraTestConnectionTest` (no log line carries the token or its Basic header).

### The Flow consumer

`flow/Flow.kt` `configureFlow`, `infra/outbound/FlowOrigins.kt`. Flow (the sibling app) is read through its read-only service token
(bearer `flow_int_` + 43 base64url characters). It is a PRIVATE address for the Flow of this deployment, so "A private host" is wired
with a development-only extension, all of it OPERATOR configuration (`flow.*`, boot-validated, naming the key and never the value;
the keys and origins: `flow-sync.md` "The transport and origins"): `flow.allowedHosts` / `flow.allowedCidrs` / `flow.caBundle` are the
production path for a TLS Flow, `flow.insecureOrigins` (exact `http://host[:port]` origins, no IP literal, default port 80) the Flow
stub and a plain-http Flow on OrbStack.

**A non-blank `flow.insecureOrigins` outside development mode refuses startup** (the `jira.stubBaseUrl` rule: `FlowBootTest`), and
`FlowOrigins` ignores the list outside development mode as defence in depth.

**An insecure host may resolve to a loopback, private or docker-network address, and to nothing else:** its addresses are refused
when they are in the `isNeverAllowed` classes minus loopback (link-local - the cloud metadata address `169.254.169.254` included -,
any-local, multicast, `0.0.0.0/8`, `::/96`, `::ffff:0:0:0/96`, NAT64 to a refused address or in `64:ff9b:1::/48`, 6to4, Teredo;
`FlowOriginsTest`), and a host that is ALSO a listed TLS host follows the listed-host rule only (never loopback, whatever the CIDRs
say). The host check still gates WHICH hosts are reachable.

**A connection's `baseUrl` must be exactly one listed origin in its canonical form** (`FlowOrigins.baseUrlVerdict`: `ALLOWED`,
`NOT_CANONICAL` or `NOT_LISTED`; the spelling rules are `flow-sync.md` "The transport and origins"; the 400 names which, never quoting
the value; wired through the composition root `infra/db/Database.kt`, which fails closed until `configureFlow` has built the rule), so
an admin can never widen the list and every origin has one spelling. A stored `baseUrl` is judged AGAIN by the transport on every
call, so one the operator has since delisted is refused (`BLOCKED_HOST`, audited once, before any DNS lookup, no retry:
`FlowBootTest`, `OutboundGuardTest`); the guarded client likewise refuses an IP-literal URL, a foreign port, plain http to a TLS host
or a caller-set `Host` header (`outbound.blocked`).

**The list is disclosed to ADMIN** (`GET /api/v1/integrations/flow/origins`, `FlowOrigins.allowedOrigins()`): operator configuration
validated host-shaped at boot (no credential, no path), shown only to the role that already reads every connection URL; it widens
nothing (the guard judges every call).

The client is the same `guardedOkHttpClient`/`guardedKtorClient` pair (no proxy, no redirects - a 3xx is `REDIRECT` - no
OkHttp-level retry) with the operator's CA bundle when set, ONE for the process, closed on `ApplicationStopped`, over
`infra/fetch/SourceHttp` (`FlowHttp.kt`; its own `OutboundPermits` and so its own big-parse lock). The numeric keys are bounded tight (`maxResponseBytes` 64 KiB..1 MiB, `maxConcurrentRequests` 1..2; the rest are `flow-sync.md`'s).

**The token** exists in memory only inside `HttpFlowClient`'s `Authorization` value (and the decrypted `FlowConnectionTarget`, which
masks it; both request and target are in the log-hygiene class list), is decrypted by `FlowConnectionService.readForTest` /
`readForRun` only (`sync.md` "A stored token's life") and never reaches a URL, a log line, an audit line, a problem body or a failure
message (a `FetchException` carries the host and path of the request, never a query).

**The contract has one Kotlin home**, `flow/FlowDocument.kt` ("The contract and drift" in `flow-sync.md`); the decoder is strict where
an absence would read as a value (`INVALID_RESPONSE`, never "empty" or "false"). The failure codes (`AUTHENTICATION_FAILED` for Flow's
uniform 401, never retried) are `flow-sync.md`'s.

In k8s the egress NetworkPolicy still excludes private ranges (`ci.md` "Running the full stack" for the Flow egress override); the
policy is the second layer.

Pinned by `FlowOriginsTest`, `FlowBootTest`, `FlowClientTest` and the Flow cases of `OutboundGuardTest`.

### The heap arithmetic

Why there is no second heap-fit check. The process has TWO permit pools and TWO big-parse locks (one `SourceHttp` per connector),
and the sum stays bounded because each pool is bounded by its own keys: Jira's by `JiraHeapFit` (boot refuses a configuration that
does not fit), Flow's by bounds tight enough that NO configuration can exceed the 96 MiB reserve `JiraHeapFit` keeps for what is not
Jira's. Using that model (112 B of tree per node, one node per 8 wire bytes): at the 1 MiB ceiling one Flow body is 1 MiB on the
wire and at most 1 MiB / 8 = 131,072 nodes x 112 B = 14 MiB parsed, and a body of at most 1 MiB is below the transport's big-parse
threshold, so Flow never takes its lock and two calls may parse at once: worst case 2 x (1 MiB + 14 MiB) = **30 MiB**, plus the
decoded `FlowTeamsDocument`, which lives beside the tree until the decode returns (`HttpFlowClient.teams` decodes inside the
transport's transform; not measured here). The defaults (1 MiB x 1) pin 15 MiB. The 112 B and the reserve are measurements, not yet
re-measured on Astrolabe.

### A private host

The operator allowance. A self-hosted upstream usually lives on a private address, which the
guard refuses by design. `infra/outbound/SelfManagedHosts.kt`, `Cidr.kt` and `CaBundle.kt` (their consumer is the Flow sync) widen it for ONE connector from OPERATOR configuration only (never from anything a user or admin types):

- exact lowercase hosts (no wildcards, no IP literals, no credentials in a config value);
- CIDRs a listed host may resolve to (boot refuses `/0`, IPv4 wider than /8, IPv6 wider than /32 and anything overlapping the
  never-allowed space: loopback, link-local - the cloud metadata address `169.254.169.254` -, any-local, multicast, 6to4, Teredo,
  IPv4-mapped, `::/96`, `::ffff:0:0:0/96` or NAT64);
- a request-origin check (`https` to a listed `host[:port]` only);
- an optional extra CA bundle added ALONGSIDE the JVM defaults (no skip-TLS or trust-all switch anywhere).

Pinned by `SelfManagedHostsTest`; in k8s the egress NetworkPolicy still excludes private ranges, so such a host needs its own egress
rule (the policy is the second layer, the guard the first).

## CORS, forwarded headers and CSRF

**CORS is off by default** (`plugins/Http.kt`): the plugin is installed only when `http.corsHosts` (`$CORS_ALLOWED_HOSTS`,
comma-separated hosts) is non-empty; production is single-origin and dev goes through the Vite proxy - no `anyHost()`.

**Reverse proxy:** set `HTTP_BEHIND_PROXY=true` (config `http.behindProxy`) when TLS terminates at an ingress/proxy - it installs
`XForwardedHeaders`, so rate-limit buckets key on the real client IP and the HTTPS redirect sees the real scheme. Off by default
because honoring these headers from direct clients lets them spoof both.

- It honours ONLY the canonical `X-Forwarded-Host`/`X-Forwarded-Proto` (Ktor's defaults also read
  `X-Forwarded-Server`/`X-Forwarded-Protocol`/`X-Forwarded-SSL`/`Front-End-Https`, which a proxy that sets just the canonical ones
  passes through from the client untouched) and never `X-Forwarded-Port` (a client-supplied non-numeric value would throw a 500
  out of `CallSetup` before any route ran; nothing reads it). The proxy must set (and strip client-supplied) `X-Forwarded-For`/`X-Forwarded-Proto`.
- **`X-Forwarded-For` is folded before Ktor ever reads it.** Ktor's `XForwardedHeaders` reads the FIRST header LINE only, so a proxy
  that APPENDS a fresh line instead of merging into the client's (HAProxy's `option forwardedfor`) would leave the client-supplied
  first line as the trusted value. `resolveForwardedForOrigin` (`plugins/Http.kt`, `Setup` phase, before `XForwardedHeaders`) reads
  every line via `getAll`, folds them into one hop-ordered list and resolves the trusted hop into the call's
  `MutableOriginConnectionPoint`; `XForwardedHeaders` runs with an empty `forHeaders` so it never overwrites that result.
- **The hop selection** is read from the END of the combined list, keyed on `HTTP_PROXY_HOPS` (config `http.proxyHops`,
  boot-validated >= 1 via `requireConfigInt`): 1 (the default, one TLS-terminating proxy that APPENDS) trusts the value the last
  proxy wrote; N skips the N-1 addresses trusted proxies appended after the client's - never the first value, which is
  client-supplied and spoofable. A hop count in excess of what the request carries falls back to the last available value (the
  fallback Ktor's own `useLastProxy()`/`skipLastProxies()` apply) rather than throwing.
- Covered by `ForwardedHeadersTest`; the multi-line fold itself needs a real Netty engine to pin (`RawForwardedForLinesTest` writes
  the raw HTTP/1.1 request by hand - ktor-client's own request writer folds repeated `header()` calls into one wire line before
  send).

**CSRF** install is gated behind `security.csrf.enabled` (default **`false`** in `application.yaml`, env-overridable via
`SECURITY_CSRF_ENABLED`); the configured `originMatchesHost()` + `allowOrigin("http://localhost:8086")` +
`checkHeader("X-CSRF-Token")` combo is unsatisfiable from both the Ktor test client and the dev SPA on `:5178`, and CSRF protection
is anyway moot for this app's bearer-JWT auth model - browsers do not auto-attach `Authorization` headers, so cross-site forms
cannot forge an authenticated request. Re-enable only if you move to cookie-based session auth and fix the allow-list accordingly.

## Default admin

Migration `V3__seed_admin.sql` inserts a single bootstrap administrator on first boot (`admin@astrolabe.local`, role `ADMIN`, with the
well-known initial password the bootstrap check refuses in production), idempotent via `ON CONFLICT DO NOTHING`. The migration is
kept **unchanged** (dev + e2e depend on it; checksums must not change) - production neutralizes it at startup via "The startup
checks". There are no demo seed users.

## Kubernetes and compose

### Secrets

Kubernetes secrets live in the `astrolabe-secrets` Secret in the `astrolabe` namespace (`k8s/secret.yaml` is a placeholder template
- create the real one out-of-band with the `kubectl create secret generic` command in its header; the `app` Deployment consumes it
via `secretKeyRef`).

### Probes

`k8s/app-deployment.yaml`. Every probe (`startupProbe`/`readinessProbe`/`livenessProbe`) sends
`X-Forwarded-Proto: https` - the header the TLS-terminating ingress sets, which `HTTP_BEHIND_PROXY`/`HTTP_PROXY_HOPS` ("CORS,
forwarded headers and CSRF") makes the app trust (under the local overlay the header is ignored, harmlessly - development mode
never redirects). Without it, production mode answers the kubelet's plain-HTTP probe request with a 301 to `https://<pod-ip>/`,
which the kubelet FOLLOWS (same host) into a refused `:443` - every probe fails and the pod crash-loops. `startupProbe` (30 x 5s = ~150s) covers JVM boot + Flyway migrations before the liveness clock starts, so
a slow first boot cannot trigger a restart.

### Pods and network policies

`k8s/*.yaml`, validated by ci.yml's `k8s-static` job - `kubeconform -strict` over the raw manifests (`k8s/*.yaml`,
`k8s/local/*.yaml`) and over what `k8s/apply-local.sh` renders.

- **Pods.** Both (`app`, `postgres`) set `automountServiceAccountToken: false` - nothing calls the Kubernetes API, so no token is
  mounted. `app`: uid 10001, `runAsNonRoot`, seccomp `RuntimeDefault`, read-only root filesystem (only `/tmp`; the AppCDS archive
  `/app/cds/astrolabe.jsa` is a root-owned 0444 file baked into the image and only ever read), no privilege escalation,
  `drop: [ALL]`. `postgres` runs the same way minus the read-only root filesystem (`readOnlyRootFilesystem` stays off: it writes its socket/lock files under
  `/var/run/postgresql` and temp files under `/tmp`): `runAsNonRoot` as the alpine image's own `postgres` user (**uid/gid 70** - 999
  in the Debian image, so change `runAsUser`/`runAsGroup`/`fsGroup` together with the image variant), `fsGroup: 70` with
  `fsGroupChangePolicy: OnRootMismatch`, seccomp `RuntimeDefault`, `allowPrivilegeEscalation: false`, `drop: [ALL]` (a non-root
  start needs no capability: the entrypoint's chown/gosu step only runs as root).
- **Compose parity.** The compose `app` service carries the same container posture (`read_only: true` with a `/tmp` tmpfs,
  `cap_drop: [ALL]`, `no-new-privileges`); `postgres` and `mailpit` stay as shipped (the postgres entrypoint starts as root and
  needs setuid/chown capabilities).
- **`k8s/network-policies.yaml`.** `default-deny-all` (ingress AND egress for every pod in `astrolabe`), then: `postgres` accepts
  5432 only from `app`; `app` accepts 8086 (the front door, below); `app` may egress to `postgres:5432`, to cluster DNS (kube-system
  `k8s-app=kube-dns`, 53 UDP/TCP) and to public addresses on 443, 587/465/25 (SMTP) - RFC 1918, link-local (cloud metadata
  `169.254.169.254`) and CGNAT ranges excluded, so a compromised pod cannot reach other namespaces or cluster services.
- **Things that need their own extra policy:** an in-cluster/private SMTP relay, an OTLP collector (`OTEL_*_EXPORTER=otlp`; the
  default is console), any private upstream (the OrbStack overlay adds the Jira-stub, Flow-stub and real-Flow pairs in
  `k8s/local/jira-stub.yaml`, `flow-stub.yaml` and `flow-egress.yaml`, named in `ci.md` "Running the full stack"; the base never has
  any of them).
- **Cluster assumptions:** DNS is matched as pods labelled `k8s-app: kube-dns` in `kube-system` (stock CoreDNS); a NodeLocal
  DNSCache or OpenShift (`openshift-dns`, different labels) needs the DNS rule adjusted, or every lookup times out; SMTP submission
  on port 2525 and any IPv6 destination are not covered (the `ipBlock` is IPv4 only). Enforcement needs a CNI that implements
  NetworkPolicy (OrbStack's local cluster does); one that does not leaves the objects inert. New pods take a few seconds to be
  programmed, so a very fast first connection can fail once - the `startupProbe` window absorbs it.

### The front door

Kubernetes is a LOCAL deployment target (OrbStack): `k8s/app-service.yaml` is a `LoadBalancer`, reached over plain HTTP.

- The `app` Deployment reads `KTOR_DEVELOPMENT`/`HTTP_BEHIND_PROXY`/`HTTP_PROXY_HOPS` from the ConfigMap `astrolabe-front-door`,
  and `k8s/apply-local.sh` applies the OVERLAY `k8s/local/front-door.yaml` (`KTOR_DEVELOPMENT=true`, `HTTP_BEHIND_PROXY=false`:
  development mode behind no proxy, so no HTTPS redirect, `/openapi` exposed, the burned/seed credentials tolerated and the
  `X-Forwarded-*` headers ignored; the real secrets still come from `astrolabe-secrets` and `ADMIN_INITIAL_PASSWORD` still rotates
  the seeded admin) INSTEAD of the base `k8s/front-door.yaml`.
- The base file stays the **production posture** for a TLS-terminating Ingress that sets and overwrites `X-Forwarded-For`/`-Proto`
  and is **unsafe behind a bare LoadBalancer**: plain HTTP gets the 301 to `https://`, and the headers are client-controlled, so the
  per-IP rate-limit key and the redirect skip are spoofable. Cost accepted: no deployment target runs production mode; only the
  server suite proves it (compose is development mode too).
- `allow-app-ingress` is unchanged on purpose: LoadBalancer traffic reaches the pod from outside the cluster, so no pod or
  namespace selector can name its source and the port is the restriction; a deployment that adds a TLS Ingress and a `ClusterIP`
  Service adds the controller's namespace selector there.
- A ConfigMap change does not restart the pod (the env is read when a container starts): `apply-local.sh`'s unique image tag rolls
  the pod on every run. CI (`k8s-static`) pins the base file to `"false"`/`"true"` and the rendered directory to exactly one
  `astrolabe-front-door` ConfigMap carrying the overlay.

## Log hygiene

Every data class that carries a password, token, MFA code, password hash or signing key (the auth requests and responses, `User`,
`UserCreateRequest`, `PasswordUpdateRequest`, the Jira and Flow connection requests and targets, `JwtConfig`, the MFA challenge types,
`IssuedToken`) overrides `toString()` and prints each secret through `maskedSecret` (`infra/Secrets.kt`: `***`, or `null` when
absent), so templating one into a log line or an exception message never reveals it; a new secret-bearing class does the same. Pinned
by `SecretToStringTest`.

- `infra/db/Flyway.kt`'s startup log line renders the operator-supplied JDBC URL through `jdbcUrlForLogging()` - `host:port/db`
  only, no userinfo or query string - so a `jdbc:postgresql://host/db?user=...&password=...` form never lands a credential in the
  log (`observability.md` "Never log secrets"); covered by `FlywayLogTest`.
- `POST /api/v1/logout`'s malformed-body debug line (`auth/AuthSessionRoutes.kt`) logs only the parse failure's exception CLASS NAME, never
  the throwable - the cause chain can embed a body excerpt (kotlinx's decode-error message), the same `errorType`-only rule as
  `login.mfa_send_failed`/`password_reset.send_failed`; covered by `LogoutTest`.

## Outbound email

`infra/mail/`. `configureMail` (registered at the top of the infrastructure group, before Flyway) publishes
`MailerKey` holding a `Mailer` or null. `mail.transport` (`$MAIL_TRANSPORT`) selects:

- `log` (dev default) - the full message, **including reset links and MFA codes**, goes to the `ch.nokillswit.mail` logger;
  **production mode refuses to start on it**;
- `smtp` - Jakarta/Angus Mail over `mail.smtp.*` / `$SMTP_HOST` etc.; a blank host refuses startup in any mode;
- `disabled` - the Docker image default via `ENV MAIL_TRANSPORT=disabled`; email features answer 503 through `respondMailUnavailable`.

The compose demo wires `smtp` -> the bundled Mailpit (`http://localhost:8029` - 8025-8028 belong to sibling stacks); k8s ships
`disabled` with `SMTP_USER`/`SMTP_PASSWORD` read (optional) from `astrolabe-secrets`. Consumers: self-service password reset and
email MFA. The recipient-language content layer (`LocalizedText`) lives beside the transports. Pinned by `MailTransportTest`
(production-mode boot tests must override `mail.transport` with `"disabled"`).

## Encryption at rest

`infra/crypto/`. The consumers are `jira_connections.api_token` (V21, `jira/JiraConnectionService.kt`) and `flow_connections.api_token`
(V24, `flow/FlowConnectionService.kt`); a decrypt failure reads as a null token, never an exception.

### Keys and rotation

- Sensitive columns are encrypted application-side with AES-256-GCM (`FieldCipher`: a fresh 12-byte nonce per value, 128-bit tag,
  envelope `enc:v1:<base64(nonce||ciphertext)>`), so a database-level attacker - SQL access, `pg_dump`, a stolen volume or backup -
  sees ciphertext; the key lives with the app (`DATA_ENCRYPTION_KEY`, 64 hex chars from `openssl rand -hex 32`; compose ships a
  burned demo key, k8s reads `astrolabe-secrets`), never in the database. **Losing the key loses every encrypted value** - back it
  up apart from the DB.
- **Rotation:** set the OLD key as `DATA_ENCRYPTION_KEY_PREVIOUS` (decrypt-only fallback - a wrong-key attempt fails cleanly on
  GCM's tag, then the previous key is tried) and the new one as `DATA_ENCRYPTION_KEY`, then re-encrypt every row under the current
  key and remove the previous key. A new rotation therefore ends with one boot under both keys, after which
  `DATA_ENCRYPTION_KEY_PREVIOUS` can be removed.
- **The registry and the boot backfill:** a service owning encrypted columns implements
  `EncryptedAtRest` (`infra/crypto/EncryptedAtRest.kt`) and is listed in `encryptedAtRestServices()` in `infra/db/Bootstrap.kt`
  (never remove a registration once one lands - a rotation would strand that feature's rows; `EncryptedAtRestBootTest` fails an
  implementer that is not listed). At every boot the loop calls each service's `encryptLegacyRows(reencryptAll)`: without
  `security.encryption.previousKey` it wraps only rows still holding plaintext, with it it re-encrypts EVERY row (soft-deleted ones
  included) under the current key, through `Reencrypt.kt`'s `reencryptRows` - the ONE sanctioned SQL predicate over an encrypted
  column is its `notLike "enc:v1:%"`. A pass that touched rows logs one INFO line and the audit event `crypto.reencrypted` (`rows`,
  `label`, `rotating` - counts and a noun, never a value).
- **A rotation boot that meets an envelope neither key opens fails closed** (a `GeneralSecurityException` in the cause chain, the
  whole backfill is ONE transaction so no row was touched; keep that behaviour: a half-rotated table is worse than a refused boot).
- **Never filter or sort on an encrypted column in SQL** - ciphertext carries no order or equality (every value has its own nonce).

### Recovery after a failed rotation

Without printing a value: do NOT change the keys again.

1. Boot once under the configuration the rows were last readable under (the pre-rotation `DATA_ENCRYPTION_KEY`, no previous key):
   that boot decrypts nothing.
2. Find the stranded rows: Test connection on each Jira connection answers `TOKEN_UNREADABLE` for exactly those, and the server logs
   `The stored API token of Jira connection <id> cannot be decrypted (<exception class>)` (an id, never an envelope); in SQL
   `SELECT id, name, marked_as_deleted, updated_at FROM jira_connections ORDER BY id` lists the rows without touching the column.
3. For each: edit the connection and enter its token again (a present token is encrypted under the current key), or delete it (a
   delete sets it NULL). Only an ACTIVE row can be stranded: a delete writes NULL, which a rotation skips, so a deleted connection
   never blocks one.
4. Rotate again: previous = the old key, current = the new one, one boot.

### The credential columns

- **A stored token is only ever an envelope (or, on a deleted row, NULL):** V21's `ck_jira_connections_api_token`
  (`api_token IS NULL OR api_token LIKE 'enc:v1:%'`) and `ck_jira_connections_api_token_live` (`marked_as_deleted OR api_token IS NOT NULL`)
  make the database refuse a plaintext value and a tokenless active row, so the boot backfill's plaintext wrap can no longer fire on
  this table (its code path is proven on a throwaway table and stays for the next encrypted column).
- **A deleted connection keeps no credential, literally:** the delete sets `api_token` to NULL in its own transaction (no envelope
  under an old key is left for a rotation to open); the readers read ACTIVE rows only, and a run in flight ends `CONNECTION_GONE`
  before its next page, so a token copy in memory authenticates no further read.
- **Jira business text is plaintext by design** (issue summaries, keys, points, observations): only credentials are encrypted. The
  census mirror `jira_issues` (V23) widens that to every in-scope issue and keeps a summary it never emits: no endpoint exposes
  mirror summaries (only keys and counts) and no log line names one.
- **A credential column is write-only end to end:** accepted on create/update, never returned (the response carries a `has…` boolean
  instead), never in an audit line or a log line, and **never decrypted on a read path**. The few decrypting readers (the
  connection service's three for Jira, two for Flow) and the decrypt-or-null rule are `sync.md` "A stored token's life"; each hands the
  plaintext to the connector that calls the upstream and nothing else, and `JiraTestRecorder` and `JiraMappingStore` never select or
  see the token. The paths a non-ADMIN can trigger (the bind and the two import routes, through `readForBind`) decrypt only after
  their up-front authorization.
- **`sync/` never names the credential column either:** `ConnectionColumns` (`sync/ConnectionRegistry.kt`) has no token column,
  `runnableStateOf` selects only `enabled`, and each connector's `*PollRows` selection omits it (`CredentialPathTest` pins both, and
  that `decrypt` and `decryptOrNull` have no other caller).
- **A caller refused by the up-front checks never makes the server decrypt** (the order is `authorization.md` "Jira import" and
  `jira-sync.md` "Import": the import routes check the connection with the non-decrypting `runnableState` and call `readForBind` only
  after the named-target `404`s and the up-front `403`s, `JiraImportRoutes.admit`; the preview's resolved-target `403` and the apply's
  under-the-lock `403` still come after the decrypt, the deliberate cost `authorization.md` records). `JiraImportDecryptOrderTest`: an
  undecryptable envelope leaves one "cannot be decrypted" WARN per decrypt, none for a refused caller.
- **A run's stored failure text is URL-free** like it is token-free (`sync.md` "Rules": `{code} ({status})`, never the exception
  message; `JiraRunFailureTest`). A decrypt failure is a typed `TOKEN_UNREADABLE` row (Test) or a `409` (Peek, bind, the import
  routes), never a `500`.

### Pinned by

`UnreadableTokenTest` (class name only in the WARN), `CredentialPathTest` (the source scan: who may call `decrypt`/`decryptOrNull`, no
token in the poll-row selections or `sync/`), `FieldCipherTest`, `CryptoBootTest`, `EncryptedAtRestBootTest` (the backfill body on a
throwaway table, a rotation boot that moves every row, the registration scan), `JiraConnectionTest`, `JiraSchemaTest` (the CHECKs
refuse plaintext and a tokenless active row).

## Trusted PostgreSQL extensions

`unaccent` (V4) is a contrib extension trusted since PG13: `CREATE EXTENSION IF NOT EXISTS` needs only `CREATE` on the database, no
superuser. A future `btree_gist` (overlap-exclusion constraints, e.g. effective-from capacity periods) is the same class.

## Telemetry

`telemetry/` (`observability.md` "Telemetry") records Astrolabe's own vital signs into `ops.*` and serves them to ADMINs only
(`GET /api/v1/telemetry/current` and `/history`, `authorization.md`; per-user bucket `telemetry`, 30/min); a USER gets the uniform
`403`. What it discloses to an ADMIN:

- **Process identity** (the row, its instance label control-free and ≤ 100 characters: `observability.md` "The process row") and the live memory, CPU, thread, GC and connection-pool
  figures; NEVER JVM arguments, environment variables, system properties, request paths with identifiers or any project data (pinned:
  the `ops` tables hold numbers and these labels only).
- **Route usage:** the normalised API routes (path parameters as written, never an identifier) with their request counts, latencies
  and 5xx / 429 counts; the telemetry routes themselves and the probes are excluded.

**Metric-name cardinality is bounded.** Ktor's `DropwizardMetrics` (3.6) names a meter after `request.uri` - query string included -
for every response it could not route and for every second response of a call (the StatusPages re-answer of the RateLimit plugin's
bodiless `429`, routing's `405`), and a registered instrument is never evicted: an unauthenticated client (`POST /api/v1/login?x=<random>`
past the login bucket, random unrouted paths or methods) could mint one meter per distinct URI until the heap is gone. So
`plugins/Monitoring.kt`'s `TelemetryRegistry` registers NO `ktor.calls.` name containing a `?` (the caller gets a detached,
unregistered instrument), caps the whole `ktor.calls.` family at 2,000 registered names (past it: detached instruments and one WARN),
and the reporter filters out any name with a `?` as defence in depth. Pinned by `TelemetryRegistryTest`.

## Not yet ported

Nothing remains beyond the SSRF rules in "Outbound HTTP calls" and "A private host" (a new outbound consumer takes the allow-list, the origin check and the bounded read); new subsystems arrive with their own section here.
