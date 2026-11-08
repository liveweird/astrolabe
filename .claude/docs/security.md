### Security posture: development vs production mode

`ktor.development` is env-overridable (`$KTOR_DEVELOPMENT:true`): local `:server:run`/tests
default to development mode; **the Docker image ships `KTOR_DEVELOPMENT=false`** (production
mode), and `docker-compose.yaml` explicitly sets it back to `true` because it is the local
plain-HTTP demo. Production mode activates HSTS + HTTPS redirect and **fail-closed startup
checks**:

- **JWT secret** (`plugins/Security.kt`): production requires a private 64-character hex key
  generated with `openssl rand -hex 32`. Blank, malformed, repeated-character and publicly
  committed values (including the compose demo key and Kubernetes template placeholder) refuse
  startup. Development warns and retains its demo behavior. The format check cannot establish
  randomness; generate and store the key privately.
- **Seed passwords** (`infra/db/Bootstrap.kt`, module `configureBootstrap`, runs after
  `configureDatabase`): in production mode, if any active account still carries the well-known
  `changeme` bcrypt hash the app **refuses to start**. The seed admin is also checked against
  known plaintexts so a freshly salted hash of an unsafe initial password from an older build
  cannot pass that hash-equality check. Setting `ADMIN_INITIAL_PASSWORD` (config
  `bootstrap.adminInitialPassword`) rotates the V3 seed admin's password at startup — idempotent:
  only applied while the admin still has the seed hash, so an admin-chosen password is never
  overwritten. Before rotating in production, bootstrap rejects the known `changeme`/`CHANGE-ME`
  values and applies the normal account password length and bcrypt byte limits. Covered by
  `BootstrapTest`; seed-mutating tests restore state via `TestSeedState.restoreSeedAccounts()`
  (`TestEnvironment.kt`).
- **Mail transport** (`infra/mail/Mail.kt`): `mail.transport=log` writes outbound email (including
  password-reset links and MFA codes) into the application log — permitted with a warning in development,
  **refuse to start** in production; `smtp` with a blank host refuses to start in **any** mode.
  A non-blank `mail.appUrl` that is not the deployment's `https` origin (`http` only in development; no
  path, query, fragment or userinfo) refuses to start in **any** mode (blank is allowed: the reset answers 503
  and boot warns). See "Outbound email" below.
- **Data-encryption key** (`infra/crypto/Crypto.kt`, module `configureCrypto`, right after
  `configureMail` and BEFORE `configureDatabase`): blank or the burned repo-committed dev default
  → warn in development, **refuse to start** in production; a malformed key (not 64 hex chars —
  the k8s template placeholder included) refuses in ANY mode. See "Encryption at rest" below.
  Covered by `CryptoBootTest`; every production-mode boot test overrides
  `security.encryption.key` with `strongEncryptionKey()`.

**Everything development mode relaxes** (the k8s `k8s/local/front-door.yaml` overlay and compose run it; each item
is the code's own switch on `developmentMode`): no HTTPS redirect and no HSTS; `/openapi` and the Swagger UI
exposed, with the inline-script CSP exemption on `/openapi` and its subtree (`plugins/SecurityHeaders.kt`);
the login per-IP bucket 1000/min instead of 10/min and the password-reset bucket 100/min instead of 5/min
(`plugins/RateLimits.kt`); the JWT-secret, data-encryption-key and seed-password checks only warn (the
`ADMIN_INITIAL_PASSWORD` candidate's burned-value and length validation is skipped too — `infra/db/Bootstrap.kt`);
`mail.transport=log` tolerated, which prints reset links and MFA codes into the log (`kubectl logs`);
`MAIL_APP_URL` may be `http://` (`infra/mail/Mail.kt`); `MFA_CODE_TTL_SECONDS=0` accepted (`auth/AuthRoutes.kt`);
the Jira stub host (`jira.stubBaseUrl`) may be a non-https origin and a private address (`jira/Jira.kt`; production refuses a non-blank value at boot), and the Flow origins of `flow.insecureOrigins` may be plain http on a loopback or docker address (`flow/Flow.kt`; production refuses a non-blank value at boot). The
malformed-key and malformed-`MAIL_APP_URL` refusals hold in any mode.

**JWT model** (`auth/Tokens.kt` + `plugins/Security.kt`): login issues an access/refresh **pair**,
both carrying `email`, `userId`, a `roles` array, a `typ` claim (`"access"`/`"refresh"`), a
`credentialRevision` and a random `jti`. The `jwt {}` verifier requires audience (`astrolabe-api`), issuer
(`http://0.0.0.0:8086/` by default), `typ == "access"`, and a PRESENT `jti` (a jti-less token could never be
revoked, so both the verifier and `/refresh` reject it outright). **Every authenticated request then runs ONE
uncached database statement** (`TokenBlocklistService.accessVerdict`, ported from Lettuce's `isSessionLive` and
extended; `revoked_tokens` is written by `/logout` and by the refresh rotation, the revoke path prunes expired
rows): it reads the token's user row (`role`, `credential_revision`, `marked_as_deleted`) and whether the `jti` is
blocklisted, and the token is accepted only when the account exists and is not deleted, the `jti` is not
blocklisted, the token's `credentialRevision` equals the stored one and its `roles` equal the stored role. Anything else is a `401`
audited `access.rejected` with a `reason` (`user_gone`, `revoked`, `credential_changed`, `roles_changed`, and
`malformed` for a signed access token lacking `roles`, or whose `userId` (1..4294967295) or `credentialRevision` (non-negative) is not an integral JSON
number - the same `strictLongClaim` rule as `/refresh`, so `1.0`, `1e0` and a numeric string are rejected on both paths -
a pre-deploy token, which the SPA silently refreshes), all with ONE response text ("Access token is no longer
valid - refresh or sign in again"; the audit event is coalesced to one per user and reason per minute with a `suppressed` count, like
`rate_limit.exceeded`, so a client replaying a stale token writes a line a minute, not a line per request). Structural rejections (junk, expired, wrong audience/`typ`, no `jti`) stay
unaudited and never reach the database. Nothing is cached: a logout, an admin delete, a demotion/promotion or a
password change/reset ends the token on its very next request, on any replica (the old 30-second verdict cache,
`REVOCATION_CACHE_TTL_MS`, is gone); the price is one primary-key read per request (about 1 ms). A role change does NOT bump the
credential revision, so the SPA's `401` -> `/refresh` succeeds with the new roles. Not compared: the MFA flag and
other feature flags (they ride the token until the next refresh), lockout, name/email/language. Pinned by
`StaleAccessTokenTest`. **A lookup that THROWS inside the JWT `validate` block
(database unreachable, pool acquire timeout) is an outage, not a bad token:** ported from
Lettuce, `validate` runs the lookup through `catchingFailures` (`infra/Failures.kt`)
and, on failure, stashes the cause on the call (`BlocklistFailureKey` in `plugins/Security.kt`);
Ktor's JWT provider turns any throw out of `validate` into a plain challenge, so the challenge
answers the catch-all's logged `500` (`respondInternalError`, `plugins/ErrorHandling.kt`) instead
of `401` — the SPA reads a `401` as session expiry and would sign the user out over a transient
outage. A malformed/expired/wrong-audience/wrong-`typ` token never reaches the lookup and stays
the uniform `401`. Pinned by `BlocklistOutageTest`; the OpenAPI spec already declares `500` on
every operation and the coverage gate ignores it (`CROSS_CUTTING_STATUSES` in
`OpenApiConformance.kt`), so no spec change is needed. Full token/refresh/logout semantics: see
"Authorization model" in `.claude/docs/authorization.md`.

**Token storage & response headers (the XSS posture).** The SPA keeps BOTH tokens in
`localStorage` under `astrolabe.auth.*` (`web/src/api/session.ts` — access, refresh, roles, userId,
disabledFeatures and a random session identity; no password is ever persisted; everything else in
localStorage is view state). A deliberate trade-off, documented rather than hidden: any script
running on the origin can read the REFRESH token, i.e. a renewable session unbound to device/IP — so the
real control is keeping foreign script out. **The refresh token's lifecycle (rotation with a short replay grace):**
`POST /api/v1/refresh` verifies the presented refresh token (signature, issuer, audience, a PRESENT `exp`, `typ`, a
present `jti`, not blocklisted, the user still active, `credentialRevision` current) and then CLAIMS it: an atomic
`INSERT .. ON CONFLICT DO NOTHING` of its `jti` into `revoked_tokens` (until the token's own expiry;
`TokenBlocklistService.revokeIfAbsent`, pinned directly by `TokenBlocklistRotationTest`), after which a fresh
access/refresh pair is minted. Only the claim is atomic; delivery of the response is not, so of any number of
concurrent calls with one token exactly one inserts the row (`CLAIMED`) and the rest are decided by the grace below.
**Replay grace** (`security.refresh.replayGraceSeconds`, `$REFRESH_REPLAY_GRACE_SECONDS`, default 60, 0 = strict
one-time use): a `/refresh` response can be lost after the claim committed (the SPA's 30 s deadline, a dropped VPN, a
reload mid-flight), leaving the client holding the already-retired token. So a replay of a token THIS instance rotated
less than the grace ago is answered with another fresh pair (audit `refresh.replay_grace`, `userId`) instead of a `401`
that would sign the user out; the same grace answers the loser of two tabs refreshing at once (the rotation is
recorded inside the claim's transaction, before its commit, so a racing loser, which only resumes after that commit,
always finds it). One token gets at most 2 such re-mints (`MAX_GRACE_REUSES`; a lost response or a racing tab needs one);
after that, or after the window, a replay is rejected. **A logout that REACHES the route body ends the grace**: it
drops every rotation record of the access principal's user and of the presented refresh token's own user
(`TokenBlocklistService.forgetRotations`), so a copy of a recently rotated token cannot mint after sign-out and its replay
is `reason=revoked` (it also ends the grace of that user's other devices, whose next lost-response retry then signs out:
strict, never lax). `/logout` sits behind `authenticate {}`, so it needs a valid ACCESS token: the SPA's `logout()`
(`web/src/api/auth.ts`) therefore, on a `401` (the stored access token expired after idle or a lost refresh response),
exchanges the captured refresh token for a new pair without touching the already-cleared local session
(`refreshPairDetached`) and calls `/logout` again with the NEW pair, so the live refresh token is the one revoked; if that
refresh fails the sign-out stays local only and the refresh token lives until its own expiry (<= 1 h). A direct API caller
that logs out with an expired access token gets the plain `401` and revokes nothing. Known limitation: a refresh and a
logout racing within the same few milliseconds can leave the freshly minted pair unrevoked, bounded by the refresh TTL. The rotation records (`auth/RefreshRotations.kt`, `RefreshRotationsTest`) are in memory
and per instance like the lockout/MFA state (single replica) and capacity-bounded at 10,000: when full, records whose
token has expired or whose grace has passed are evicted first and, if it is still full, the NEW record is dropped. A
restart, or a dropped record, loses them and the behaviour falls back to strict. Outside the grace, a replay of a rotated token the instance still remembers is a `401`
audited as `refresh.rejected reason=replayed`; a token blocklisted by logout (or whose rotation is not remembered) is
`reason=revoked`, so the trail separates theft/replay from logout. The accepted cost of the grace: a stolen token replayed
within the grace of its legitimate rotation also gets a pair, at most twice (the window is short, the replay is audited and a logout ends it). There is
deliberately NO family-wide revocation and no "sign out everywhere": a replay outside the grace does not end the live
chain, and a stolen token that refreshes FIRST makes the victim's next refresh the rejected replay (the victim is signed
out and the trail shows `replayed`). The access token a rotation supersedes is not revoked: it stays valid until its
own expiry (<= 15 min; only a logout blocklists an access token, and the per-request check above ends it on any
delete, role change or password change). `POST /api/v1/logout` revokes the access token it is
called with and the one refresh token the client sends in the body (best-effort; both jtis go to the blocklist); it does
NOT end other pairs of the same user. What does end every outstanding refresh token of a user is a password
change/reset/bootstrap rotation (the `credential_revision` bump) or an admin deleting the account (`/refresh` re-reads
the user), and the same events end the ACCESS token at its next request (the per-request check above); an idle session
also ends at the refresh TTL. The cost is one `revoked_tokens` row per refresh (about one per
15 minutes per active session, pruned at the next revoke once expired). The SPA copes with two tabs sharing one session
(`web/src/api/http.ts`, `web-internals.md`). The keep-script-out control is `plugins/SecurityHeaders.kt`, installed unconditionally and pinned by
`ServerTest`: a strict CSP (`script-src 'self'`, `style-src 'self' 'unsafe-inline'`,
`object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'` — the whole string is pinned
verbatim in `ServerTest`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()`
(also pinned verbatim), and — production mode only, `plugins/Http.kt` — `Strict-Transport-Security`
(`max-age=31536000; includeSubDomains`, pinned by `ServerTest`'s production-mode boot behind
`http.behindProxy` with `X-Forwarded-Proto: https`; absent in development). Every `/api/` JSON and problem+json answer additionally carries
`Cache-Control: no-store` (`plugins/Http.kt`'s `CachingHeaders`, pinned by `ServerTest` together
with the unchanged caching of the SPA's static assets), so per-user data never lands in a browser
or proxy cache -- including the `200`/`304` of a validator-answering view GET, which adds an `ETag` to the same `no-store` ("Caching" below). `text/html` (index.html and every SPA deep link answered with it) carries `Cache-Control: no-cache`
(revalidate every time, so a deploy's new hashed asset names are never masked by a stale shell), while the content-hashed
CSS/JS keep `max-age=86400`. The `Server` header is the fixed generic `astrolabe` (`install(DefaultHeaders) { header(Server, …) }`
in `Http.kt`) — Ktor's default `Server: Ktor/<version>` disclosed the framework and its exact version; pinned in `ServerTest`
(no `Ktor` in it).

**Caching -- a settled decision (the owner chose `no-store`).** Every `/api/` answer is `Cache-Control: no-store`. A route that answers through cache
validators (a view GET; Flow's report GETs were the first consumer, Astrolabe's `/views/*` endpoints will be) OFFERS a weak `ETag`
(`ApplicationCall.offerValidator`, `plugins/ResponseValidators.kt`) and the plugin writes `ETag` + `no-store` only when the call really ends as a `200`/`304`: so
nothing lands in a browser or proxy cache, and the server-side `304` helps only a client that sends `If-None-Match` itself (it saves the computation, not the
transfer). The rejected alternative was `private, no-cache` + `Vary: Authorization` + a logout `Clear-Site-Data: "cache"`, which would leave response bodies
on disk between logins on the same profile (best-effort clearing only). Cross-user safety of a `304` rests on two rules: authentication runs BEFORE any
validator logic (an unauthenticated request is `401` with no validator, so a `304` is never a way to probe for data), and a validator never covers content that
depends on the caller unless the caller's verdict is folded into the `ETag`. A `problem+json` response is always `no-store` and carries no validator. No
route offers a validator in v0.1.0; `ResponseValidators` is exercised by the contract tests until the first view endpoint lands.


`style-src` carries `'unsafe-inline'` deliberately: Mantine's style props/CSS variables render
inline `style` attributes and runtime `<style>` tags, and the app uses `style={{}}` itself — a
STYLES-only concession; it does not reopen script injection.

The Swagger UI is the ONLY CSP exemption (it bootstraps with inline script/style), and it applies
only when `http.exposeOpenApi` is on (`Application.exposesOpenApi()`, the same definition that
mounts the UI: the property when set, else development mode) AND the path is exactly `/openapi` or
starts with `/openapi/`. With it off — production by default — `/openapi`, `/openapi/x` and
look-alikes such as `/openapiX` are ordinary paths (the SPA catch-all answers them with
`index.html`) and carry the full CSP. The exempt paths still get the non-CSP hardening headers.
All of it is pinned in `ServerTest`.

Consequences: never weaken `script-src` (no CDN scripts, no `unsafe-inline` for scripts — Vite
bundles everything same-origin, fonts included), and the SPA must stay free of
`dangerouslySetInnerHTML`/`eval` sinks (currently zero). Moving tokens to httpOnly cookies would
trade this for CSRF machinery — revisit only with that full picture.

**Login timing equalizer** (`auth/AuthRoutes.kt` + `TIMING_EQUALIZER_HASH` in
`auth/Passwords.kt`): an unknown email pays a full, discarded bcrypt verify against a fixed
cost-12 hash so its 401 takes as long as a wrong password's — without it, response timing is an
account-enumeration oracle (the reset path equalizes via async processing; login equalizes
in-line).

**Per-account login lockout** (`auth/LoginThrottle.kt`, wired in `configureAuthRoutes`): after
`security.lockout.threshold` (default 5, `$LOGIN_LOCKOUT_THRESHOLD`) consecutive failures for one
submitted email, `/login` answers `429` for `security.lockout.durationSeconds` (default 900,
`$LOGIN_LOCKOUT_DURATION_SECONDS`) — even with the correct password, and regardless of whether the
account exists (no enumeration signal). A success resets the counter. The in-memory, per-instance (so the app runs ONE replica — `ci.yml` `k8s-static` pins it)
store has a hard `security.lockout.maxTracked` limit (default 10,000,
`$LOGIN_LOCKOUT_MAX_TRACKED`): expired state is reclaimed through an expiry index, but fresh
counters and active locks are never evicted to admit a new identity. At capacity, an untracked
identity receives an audited `429` before password verification, so saturation cannot bypass the
account throttle; tracked identities can still finish their normal flow. A fixed-size digest of
the canonical submitted identity bounds retained key size even for malformed login input;
oversized identities are also digested in audit fields instead of logged in full. The deployment
is single-replica; a restart resets the throttle. This complements the per-IP `RateLimit` bucket,
which rotating hosts sidestep. The 429 is **thrown** (`TooManyRequestsException`), never
`respondProblem`ed directly — StatusPages' generic 429 status handler rewrites any non-StatusPages
429, so only the exception path keeps the specific detail. Tests: `LoginThrottleTest` (unit,
injected clock) + `LoginLockoutTest` (route). The SPA shows a neutral temporary sign-in limit for
either 429 cause.

**Self password change throttle** (`users/PasswordChangeThrottle.kt`, wired in `configureUserRoutes`): a stolen session could otherwise grind the owner's
current password through `PUT /users/{id}/password`. The self change (never the admin reset of another user) counts wrong or missing current passwords per
USER ID in a SEPARATE `LoginThrottle` instance fed by the same `security.lockout.*` settings (5 attempts, 15 minutes, `maxTracked`): the locked attempt
answers `429` (thrown `TooManyRequestsException`) even with the correct current password, and a thief can lock only this endpoint, never the owner's `/login`
(different instance, different key). Order `403` → `429` → `400` (body, then the new password's rules) → `403` (wrong current) (`authorization.md`: the new password is
validated BEFORE the current one on purpose, so a refused new password is not an oracle for the current one). Revocation of other sessions is unchanged (the
credential-revision bump).
**What clears the counter:** a verified current password, an admin reset of that user, a completed emailed password reset (both end every session and lift even an
ACTIVE lock, `LoginThrottle.clear`), the window expiring, or a restart.
**The trade-off, plainly:** someone holding a stolen session can keep this lock active for as long as that session lives, so the owner cannot change their password
from the SPA meanwhile. The owner's exits are the email reset (503 when `MAIL_TRANSPORT=disabled`, the k8s default) or an admin reset; either ends every session. The
guessing budget: `/login` has its own counter, so a thief gets 10 guesses per 15 minutes across both endpoints (5 + 5). A stolen ADMIN session makes this throttle moot (an admin
resets any password without the current one). Audit: `password.change_denied` per attempt (bounded by the lock), `password.change_locked` once,
`password.change_rejected_locked` coalesced with `suppressed`, `password.change_capacity_rejected` (`observability.md`). In-memory and per-instance, like the login lockout;
`PasswordChangeTest` and `PasswordChangeThrottleTest` are the proof (including that `/login` still answers 200 while the change is locked).

**Self-service password reset by confirm link** (`auth/PasswordResetRoutes.kt`, `auth/PasswordResetService.kt`, V8; SPA:
"Forgot password?" on `/login` → `/reset-password`, the emailed link opens `/reset-password/confirm`; Toadie's design, 2D3).
The public `POST /api/v1/password-reset` takes `{email}` and answers a uniform `202` for any well-formed request - the
lookup, grant issuance and email delivery run **asynchronously** after the response (uniform latency, no existence oracle),
and the request **changes nothing**: no password, no session. An unknown or soft-deleted account (`findWithIdByEmail`
filters active rows) sends nothing. Each link carries a 256-bit `SecureRandom` token (43-char base64url); only its SHA-256
digest is persisted in `password_reset_tokens` with the user id, the **account snapshot** (`credential_revision` AND
`email`) and the expiry. Lookup is SQL equality on the digest, so no constant-time compare is needed (OWASP Forgot-Password
cheat sheet). The lifetime is `security.passwordReset.tokenTtlSeconds` (`$PASSWORD_RESET_TOKEN_TTL_SECONDS`, default 900,
boot-validated 1..3600). **Several links may coexist** - a newer request never revokes a usable one, or anyone typing an
address into the form could kill the owner's link; a failed delivery revokes only the grant it just minted
(`password_reset.send_failed`); expired rows are pruned on every issue. **An account holds at most 5 unexpired grants** (a constant in
`PasswordResetService`, counted under the user-row lock so concurrent requests cannot slip past it): at the cap `issue` mints
nothing, the async worker sends no email and audits `password_reset.capped` (userId only), and the request route still answers `202`
(no oracle). Earlier links stay valid. This bounds the remaining nuisance of the unauthenticated form - anyone who knows an
address can still make the owner receive reset mail, but at most 5 live links per lifetime (15 min by default) per account,
on top of the one-request-per-minute throttle. The async task that finds the account moved between its lookup and the grant insert
audits `password_reset.stale_account` (userId) and sends nothing. A grant dies on **use** (confirming deletes every grant
of that user), a **password change** (the captured `credential_revision` no longer matches), an **email change** (the captured
`email` no longer matches - an Astrolabe (Flow) deviation from Toadie, whose `auth_version` moves on email edits; the credential revision moves
only on password changes and must stay that way), an account **soft delete** and **expiry**; a role change does not
invalidate it. The email renders through `LocalizedText` in the RECIPIENT'S stored language (V1 `users.language`, EN fallback);
no email carries a password.

The link is `<mail.appUrl>/reset-password/confirm#token=…`. The token sits in the URL **fragment**, which never reaches the
server, its access logs or `Referer`; the SPA strips it from history and keeps it in component memory, and loading the page
consumes nothing (there is deliberately no token pre-check endpoint - an invalid token is learned at submit). The origin is
`mail.appUrl` (`$MAIL_APP_URL`), **configured, never derived from the request `Host`**, and validated at boot by
`configureMail` in any mode: a non-blank value must be an `https` origin (`http` only in development), with a host and no
path beyond `/`, userinfo, query or fragment, at most 2048 characters - otherwise startup is refused (a wrong origin would mail
reset tokens to another host). A **blank** value is allowed: the request route then answers `503` ("set MAIL_APP_URL") and boot
logs ONE `warn` when the transport is not `disabled`. `503` also when the deployment has no outbound email
(`MAIL_TRANSPORT=disabled`).

Public `POST /api/v1/password-reset/confirm` takes `{token, password}`. The grant is checked FIRST (`isUsable`, before any
bcrypt: a junk token never costs a hash; for the PASSWORD rules the 401 wins over a 400 - a body that fails to decode is a
400 first), then `validatePassword` (a refused password is a `400`
that does **not** consume the grant), then `PasswordResetService.complete` does consumption, the password write
(`updatePasswordInTransaction`, conditional on the captured revision) and the deletion of every sibling grant in **one
transaction**, under a `FOR NO KEY UPDATE` lock of the user row (persistence.md "Row locks vs. FK locks"), so competing confirmations (across instances too) have exactly one
winner. An unknown, malformed, expired, used or stale grant is one uniform `401` (`password_reset.rejected`). Success is `204`
with **no auto-login**: the `credential_revision` bump signs every other session out through the per-request access check and
kills pending refresh tokens and MFA challenges, while MFA stays as it was, so the next login still asks for the code. A
best-effort localized notice ("your password was reset, sessions signed out"; no token, no password) is emailed after the
response; its failure (`password_reset.notification_failed`) cannot undo the reset. A confirmed reset does **not** clear the
per-account lockout (in-memory, at most 15 minutes, per instance). A lost 204 can make a retry answer `401`: sign in with the
chosen password or request another link.

Throttling: per submitted email - one request per `security.passwordReset.minIntervalSeconds` (default 60,
`$PASSWORD_RESET_MIN_INTERVAL_SECONDS`) - uniformly for existing and unknown addresses (`auth/PasswordResetThrottle.kt`,
in-memory/per-instance like the lockout), with the hard `security.passwordReset.maxTracked` limit (default 10,000,
`$PASSWORD_RESET_MAX_TRACKED`: elapsed cooldowns are reclaimed, a fresh one never evicted; saturation rejects a new identity with
an audited `429` before any worker starts); the per-IP `password-reset` bucket (`security.rateLimit.passwordResetPerMinute`,
`$PASSWORD_RESET_RATE_LIMIT_PER_MINUTE` - blank follows the mode: 5/min production, 100/min development); and the confirm
step's own per-IP `password-reset-confirm` bucket, 10/min in every mode (not configurable - the MFA idiom). `Cache-Control:
no-store` already rides every `/api/` JSON and problem+json answer (`plugins/Http.kt`, StatusPages' 429s included); the bodiless
`204` has nothing to cache. The development `log` mail transport prints the link: it must stay inaccessible outside a local
demo (production refuses it). Tests: `PasswordResetServiceTest` (injected-clock expiry, digest storage, the single-use race,
revision/email/delete staleness, the 5-grant cap, the revision-conditional write that lets only one of two competing writers win, and
a completed reset followed by an admin password write: both succeed, the admin's password is the final one), `PasswordResetConfirmationTest` (the confirm route, its own
bucket, the byte ceiling, MFA, notification failure, the `mail.appUrl` boot contract), `PasswordResetTest` (the request route and
the full link roundtrip incl. the session revocation), `PasswordResetThrottleTest`, `LocalizedEmailTest`.


**Per-IP login bucket** (`security.rateLimit.loginPerMinute`, `$LOGIN_RATE_LIMIT_PER_MINUTE`;
every bucket is installed by `plugins/RateLimits.kt`, which also owns the bucket names — today
`login`, `refresh`, `password-reset`, `password-reset-confirm`, `mfa`, `jira-test`, `flow-test`, `ready`, and the per-USER `telemetry`, `jira-bind` and `jira-import` below): blank **follows the mode** — 10/min in production,
1000/min in development — and an explicit number pins it in either mode (the `http.exposeOpenApi`
idiom). Development is lifted because the e2e suite drives its logins from one host and would
otherwise sleep out the bucket; **the per-account lockout above is the actual brute-force defence
and is identical in both modes**. The sibling `refresh` bucket defaults to 30/min in both modes and
is pinnable via `security.rateLimit.refreshPerMinute` (`$REFRESH_RATE_LIMIT_PER_MINUTE`). The anonymous
`GET /api/v1/ready` (one pooled DB round trip per call) rides the `ready` bucket, 60/min in both modes, pinnable via
`security.rateLimit.readyPerMinute` (`$READY_RATE_LIMIT_PER_MINUTE`): the kubelet probes it every 5 s (12/min) and the
e2e global setup every 2 s (30/min), so probers stay far under it; `/api/v1/health` does no I/O and has no bucket.
The per-IP `jira-test` bucket (Test connection and Peek) is configurable too: `security.rateLimit.jiraTestPerMinute` (`$JIRA_TEST_RATE_LIMIT_PER_MINUTE`),
blank = the code default 10 in every mode, bounded `1..100` (each call fans out to Jira; anything else refuses boot). The shipped production manifests keep the
10 default; an operator may pin another value (1..100) in either mode. The e2e stacks pin 30 (`docker-compose.yaml`; the OrbStack overlay `k8s/local/front-door.yaml`,
read by the Deployment as an `optional` ConfigMap key and absent from the production ConfigMap, which `k8s-static` pins). Pinned by `RateLimitResponseTest` and `NumericConfigBoundsTest`.
The per-IP `flow-test` bucket (both Flow Test-connection routes; its OWN bucket, so a Flow test never spends a Jira one) is the same idiom: `security.rateLimit.flowTestPerMinute` (`$FLOW_TEST_RATE_LIMIT_PER_MINUTE`), blank = 10 in every mode, bounded `1..100`, the e2e stacks pin 30 (compose, the overlay `k8s/local/front-door.yaml`, an `optional` ConfigMap key on the Deployment). A test makes two outbound calls with the stored token (`me`, `teams`), so the bound is for a runaway client. The bind, the capacity preview and the capacity apply make no Flow call and ride no bucket. Pinned by `RateLimitResponseTest`, `NumericConfigBoundsTest` and `FlowTestConnectionTest`.

`RateLimitResponseTest` and `LoginTest` pin the value to `10` explicitly, since tests run in
development mode.

**Per-USER telemetry bucket** (`telemetry`, a fixed 30/min in every mode, `RateLimits.TELEMETRY`) -- keyed by the verified user id, not the client IP, so a NAT'd office is not one bucket -- for
`GET /api/v1/telemetry/current` and `/history` (ADMIN only): `configureTelemetryRoutes` mounts `rateLimit(RateLimitName(RateLimits.TELEMETRY))`
once INSIDE `authenticate {}` around both reads, so the key is the verified user id (`TelemetryRoutesTest`). The panel polls `current` once a
minute and fetches a history per expanded section, a handful a minute; each call is a few `ops` aggregations, so the
bound is for a runaway client. The rejection is the generic `429` problem and the coalesced `rate_limit.exceeded` audit event (bucket `telemetry`, `byUserId`).

**Per-USER bind bucket** (`jira-bind`, a fixed 30/min in every mode, `RateLimits.JIRA_BIND`) -- the telemetry bucket's shape, keyed by the verified user id -- for `POST /api/v1/integrations/jira/bindings` ONLY (the reads and the unbind are database-only): `jira/JiraBindingRoutes.kt` mounts it inside `authenticate {}` around the POST. Any owner of a plan node can trigger a bind, which makes up to two outbound calls with the connection's stored token, so the bound protects the shared Jira quota and caps the enumeration the pre-flight answers (`authorization.md` "what a node owner can learn"). It is a route-node interceptor, so it runs BEFORE the handler and therefore before the guard: a request that would be 404, 403 or 400 spends a token too, and an over-limit caller gets `429` whatever the request would have answered (`JiraBindingTest`). Not `jira-test`: that one is per IP and shared with Test connection and Peek (ADMIN-only). Same `429` problem and `rate_limit.exceeded` audit (bucket `jira-bind`, `byUserId`).

**Per-USER import bucket** (`jira-import`, a fixed 5/min in every mode, `RateLimits.JIRA_IMPORT`) -- the same shape, ONE bucket for `POST …/connections/{id}/import-preview` and the apply (step C5): each call browses the connection's whole scope with the stored token (up to 200 search pages) for any plan-node owner, so the shared Jira quota is bounded per account. Mounted on the route node, it runs before the handler and so before the guard: a request that would be 404, 403 or 400 spends a token, and an over-limit caller gets `429` whatever it would have answered (`JiraImportPreviewErrorsTest`). Same `429` problem and `rate_limit.exceeded` audit (bucket `jira-import`, `byUserId`). **The browse is bounded to 170 s as a whole** (`IMPORT_BROWSE_DEADLINE_MILLIS`, `JiraImportBrowse.kt`; a `502` with code `TIMEOUT`), because any plan-node owner can start one. **The bucket limits the RATE, not the concurrency:** one user can have five previews in flight at once. What still bounds the total is the transport: every search page takes one of the process's `jira.maxConcurrentRequests` outbound permits (the pool the heap-fit check sized the heap on), so concurrent browses queue for permits instead of adding load, and each holds one parsed page at a time; an administrator's Test connection can queue behind them (a preview, unlike the bind, sets no `PermitWait`). The browse never puts the token anywhere but the client's `Authorization` header (`JiraImportBrowseTest`, `JiraImportPreviewTest` assert it absent from URL, response and logs).

**Email MFA (opt-in)** (`auth/MfaChallenges.kt` + `auth/MfaEmail.kt`, wired in
`configureAuthRoutes`): a per-user second factor behind the `MFA` feature flag — **the one
inverted-default flag**: `V5` seeds every existing user as MFA-disabled and `UserService.create`
inserts the disabled row for every new user (admin create and test seeds both funnel through it),
so MFA is OFF until an admin removes the row via the features PUT (the per-user editor or the
`/feature-flags` bulk screen; mind the wholesale-replace semantics — a PUT whose disabled set
omits `MFA` ENABLES it, including the "empty array re-enables everything" idiom). With MFA
enabled, `POST /login` with correct credentials normally answers
`200 MfaChallengeResponse {mfaRequired, challengeId, expiresAt}` instead of tokens (the branch runs
AFTER `verifyPassword`, so nothing about enumeration or lockout changes; `login.success` is
deliberately NOT emitted); a 6-digit code (`generateMfaCode`, `auth/Passwords.kt`) is held in the
in-memory challenge store (config `security.mfa.codeTtlSeconds` default 300
`$MFA_CODE_TTL_SECONDS`, `security.mfa.maxAttempts` default 5 `$MFA_MAX_ATTEMPTS`; per-instance
like the throttles — a restart just means signing in again) and emailed in the user's stored
language (V1 `users.language`, EN fallback). Its hard `security.mfa.maxTracked` limit (default
10,000, `$MFA_MAX_TRACKED`) first drops expired challenges, then rejects new issuance with an
audited `429` at capacity; existing codes remain verifiable and no rejected code is emailed. A
failed or cancelled delivery discards its challenge so a retry can use that slot.
**Per-account limit** (`security.mfa.maxLivePerAccount`, default 3, 1..100, `$MFA_MAX_LIVE_PER_ACCOUNT`):
a new password-correct login gets a fresh code (unless the shared store is genuinely full: the global `429` below). Under the store lock `issue` prunes expired
entries, drops the account's entries minted under an OLDER credential revision (the password changed
since; they can never verify; entries of a NEWER revision are never touched, so a late login that read
an old revision cannot evict the owner's current challenge, and its own entry just expires unusable),
and if the account still holds the limit of the same revision drops its OLDEST by issue order (a sequence number,
not the clock, which can tie) until one slot is free; only then does the global `maxTracked` check run, so
an account at its limit is never refused by a full store (the global `429` stays for a genuinely full
store). The displaced code stops working; a late `discard` of an evicted id is a no-op. The
`login.mfa_challenge` audit event carries `evicted` (a count; never codes or challenge ids). What the
limit does: bounds the live codes per account and the memory, and stops one leaked password from filling
the shared store. What it does NOT do: bound mails or guesses per account; those stay limited by the
per-IP buckets. Guessing: `POST /login/mfa` has the hardcoded `mfa` bucket of 10/min per IP, each guess
hits one challenge's 6-digit code (1 in 10^6) and a challenge dies after `maxAttempts` (5) wrong
guesses, so one IP gets about 10 guesses a minute = 1e-5 per minute = about 1.4% per day (14,400
guesses) against a code space of 10^6, minting a fresh challenge every 5 guesses within the login
bucket; more IPs scale it linearly, and nothing bounds it per account (the accepted per-IP posture).
Accepted cost: someone who knows the password can invalidate the owner's pending code by logging in
repeatedly; the owner signs in again for a fresh one, and every such login still emails the owner,
which is the signal. Sustained, it is worse: a password holder logging in every 6 s (the production
10/min login bucket, from ONE IP) evicts the owner's fresh code within about 18 s (3 further logins at the
default limit), so the owner's "sign in again" can lose the race repeatedly. The recovery is a password
reset, which kills the leaked password: the email reset flow (`POST /password-reset` +
`/password-reset/confirm`) does NOT require the second factor (traced: no MFA reference in
`PasswordReset*.kt`; the emailed single-use link is the proof) and its confirm bumps the credential
revision, which also invalidates every pending challenge. Where mail is disabled the reset request
answers `503`, which leaves the ADMIN reset (`PUT /users/{id}/password`). Eviction happens before the delivery
outcome, so a failed mail can cost the oldest code with no replacement. MFA failures do NOT feed the
login lockout (`LoginThrottle` only counts password failures). A code verifies only with the
`challengeId` of its own login, so the code step's wrong-code message says to use the code emailed for
THIS sign-in or sign in again (Back loses the `challengeId`; no server call is made on Back; "the
newest email" would be wrong with a second tab or device, and an evicted challenge rejects every
code). An exhausted,
verified, discarded (failed delivery) or expired challenge frees its slot. Delivery failures are
logged by exception class only (`MFA code email delivery failed (<Class>)`), like the password-reset
line.
`POST /api/v1/login/mfa` `{challengeId, code}` (own per-IP bucket `"mfa"`, hardcoded 10/min in
every mode) exchanges it for the ordinary `LoginResponse` — one fresh `userService.read` first
(the `/refresh` precedent: current roles/flags; a user deleted in between → the uniform 401
`user_gone`); every failure mode (unknown/expired/wrong code/attempt cap) is a **uniform 401**,
reasons live only in the `login.mfa_failure` audit event; challenges are single-use and bound to
the credential revision verified at the password step; a subsequent password change/reset
invalidates the pending challenge. **Mail-less deployments fail closed**: on
`MAIL_TRANSPORT=disabled` an MFA-enabled login answers `503` (`login.mfa_unavailable`) — don't
enable MFA flags on the k8s default `disabled` transport; the features PUT keeps working, so an
admin can always flip the flag back. SPA: the Login card's second step (`PinInput`, `auth.mfa*`
keys). Tests: `MfaChallengesTest` (pure store) + `MfaLoginTest` (route matrix); e2e `mfa.spec.ts`
drives the emailed code through Mailpit.

**Swagger/OpenAPI gate** (`plugins/Routing.kt`): `/openapi` (UI + spec) is served only in development
mode, or when `http.exposeOpenApi` (`$HTTP_EXPOSE_OPENAPI`) is explicitly `"true"` — blank follows
the mode, `"false"` hides it even in dev (the mount lives in `configureRouting`; the CSP exemption follows the same condition). Bearer auth cannot protect a browser-loaded UI (page
loads carry no `Authorization` header), hence a gate rather than `authenticate {}`.

**Accounts are admin-managed.** There is no self-signup: administrators create accounts at
`/users/new`. The initial password is generated CLIENT-side (`web/src/utils/password.ts`, 96
bits) and shown to the admin exactly once in the reveal modal — the server stores only the bcrypt
hash and no response ever carries plaintext; users rotate it via the Change password page (the
existing `PUT /users/{id}/password` rules). Deletion is the soft-delete convention plus two
guards: no self-delete (403) and the last active administrator can be neither deleted nor demoted
(409).

**Canonical email identity.** Emails are folded to `trim().lowercase()` (`canonicalEmail` in
`infra/validation/Email.kt`, shared with the Jira connection's account email) at EVERY entry point — login and `findWithIdByEmail` itself (defense-in-
depth) today, and every future create/update/import — so one mailbox is one account and a
padded/case-variant login matches (and shares one lockout bucket). The V1 partial unique index
stays byte-wise (all writes are canonical).

**Request body ceiling.** `RequestBodyLimit` (installed in `plugins/Http.kt`,
`MAX_REQUEST_BODY_BYTES` = 10 MiB) rejects oversized bodies with a 413 problem (mapped in
`plugins/ErrorHandling.kt`) before any receive/validation work — a memory-DoS backstop, not a
business rule; field-level `maxLength` validation rejects oversized values far earlier on ordinary
payloads. Declared in the spec on every body-taking operation (25 today; the spec is the source of the count) and covered by the one
`PayloadValidationTest` case.

**Slow requests (Netty read timeout).** `ktor.deployment.requestReadTimeoutSeconds` (`$REQUEST_READ_TIMEOUT_SECONDS`, default **60**, `0` = off). `configureHttp` refuses an out-of-range value (outside 0..3600) at boot in every mode, naming the key; a non-numeric one fails earlier, inside `EngineMain`'s own `toInt()` (a `NumberFormatException` without the key). No production-only rule. `EngineMain` reads the key, so it exists only on the real Netty engine, never under `testApplication`. `RequestReadTimeoutTest` boots the real app through `EngineMain.createServer` and speaks raw HTTP; what it pins is marked *tested*, the rest was read from the Ktor 3.6.0 bytecode (`KtorReadTimeoutHandler` is Netty's `ReadTimeoutHandler`, in the HTTP/1.1 pipeline only; `NettyHttp1Handler.exceptionCaught`).
- *Tested:* it is an **idle-read gap** that restarts on every inbound read, NOT a total body deadline: a body trickled with gaps below the timeout is never cut, so a trickling client keeps a request open indefinitely (the bounds there are the 10 MiB body ceiling, the DB pool and the route's re-guard under `plan_state`, not this timeout).
- *Tested:* when no byte arrives for the whole interval while a request is open, Ktor writes a `408` (`Content-Length: 0`, `Connection: close`, no problem body, written by Netty outside the app pipeline so it is not in the OpenAPI spec) and closes the connection. The call is cancelled; `ErrorHandling` treats any `CancellationException` as expected (no 500 attempt, no ERROR) and logs ONE INFO line `Request timed out waiting for bytes (408): METHOD path` for a read timeout (DEBUG for any other cancellation, a client that hung up included).
- *Tested:* an idle keep-alive connection with no request open is not closed.
- *Tested, KNOWN LIMITATION:* Ktor's `KtorReadTimeoutHandler` fires only ONCE per connection. If a connection idles past the timeout with no request open, that firing is spent (Netty logs one WARN "exceptionCaught() ... reached at the tail of the pipeline" for it) and a request that then stalls on the same connection is never cut. So the timeout only guarantees anything for a connection that has not yet idled that long: a client can defeat it by pausing once. Fixing it means replacing the handler in an engine `channelPipelineConfig`, which `EngineMain` does not expose, i.e. a custom `mainClass` (and a regenerated AppCDS class list); see `BACKLOG.md`. The real defence for slow bodies is an ingress `client_body_timeout`/`proxy-read-timeout` at or below this value (no Ingress or proxy ships with the manifests). The pinned test fails the day Ktor fixes this: then update this paragraph.
- *Bytecode only, untested:* the gap also counts the time a handler runs AFTER the request is fully read (the call stays in `activeCalls`), so the value must outlast the slowest legitimate call, a writer queued behind the `plan_state` lock included: such a request gets a 408 (and its work is cancelled) once the lock wait plus the work exceeds 60 s without a byte arriving. Nothing in the repo is expected to approach that (pool acquire is 10 s; the SPA gives up at 30 s anyway).
- Default 60 s = twice the SPA's 30 s request deadline (`web/src/api/http.ts`), the nginx `client_body_timeout` default, and well above the pool-acquire wait; legitimate bodies are small JSON (field `maxLength`s). The write side is Ktor's own `responseWriteTimeoutSeconds` default of 10 s (a stalled response write), not configurable here.

**Request payload validation (convention — API-SEC-003/API-ERR-005).** Mutating routes validate
payloads up-front and throw `BadRequestException` (→ `400` + `ProblemDetail`) instead of letting
oversized/blank values die in the DB as `500`s. One cross-cutting example: password ≥
`MIN_PASSWORD_LENGTH` (10) chars AND ≤ 71 UTF-8 bytes (`validatePassword` in `users/UserRoutes.kt`
+ `MAX_PASSWORD_BYTES` in `auth/Passwords.kt` — **the bcrypt ceiling**: longer input makes bcrypt
throw, and the 500-vs-401 split would be an account-enumeration oracle, so login's
`verifyPassword` guards it too). Declare limits as `maxLength` in the OpenAPI spec. Keep new
validators feature-local and enforce them **after** the authz guard (403 wins over 400). Covered
by `PayloadValidationTest`.

**Outbound HTTP calls (SSRF posture).** The consumers are the Jira sync (v1.1.0, `jira/`) and the Flow sync (v1.5.0, `flow/`); every server-initiated HTTP call (a sync, a webhook, anything) goes through `infra/outbound/`:
`OutboundGuard.kt` ports Toadie's `UrlFetch.kt` `isBlockedAddress` (loopback,
site-local, link-local, any-local, multicast, IPv6 unique-local `fc00::/7`, CGNAT `100.64.0.0/10`,
`192.0.0.0/24`, benchmarking `198.18.0.0/15`, "this network" `0.0.0.0/8`, reserved `240.0.0.0/4` (the limited broadcast
`255.255.255.255` inside it), a NAT64 `64:ff9b::/96` address embedding a non-public IPv4, and the whole of the
local-use NAT64 prefix `64:ff9b:1::/48`), adding two things: an IPv4-mapped IPv6 address is unwrapped to its IPv4 form first, and 6to4 `2002::/16`
and Teredo `2001:0::/32` are blocked (both pinned by `OutboundGuardTest`), as defense in depth. The PRIMARY
boundary is a **host allow-list** the caller supplies (a connector allows exactly its provider's API hosts; a development-only stub
host may be added in development mode and is refused at startup in production, like the crypto-key/mail-transport checks). `GuardedDns`
(an `okhttp3.Dns`) re-checks the allow-list and re-resolves + re-checks addresses on every NEW connection (not just once per request, since the
client is long-lived and shared — pooled connections REUSE an already-checked address rather than re-resolving on every call); the address rule is an
injectable `addressAllowed(host, address)` (default `publicAddressesOnly`, i.e. `!isBlockedAddress()`; the lookup is all-or-nothing, one refused answer
fails it). The client also checks every request's origin (`https` on 443 to an allowed host) and refuses a request carrying a caller-set `Host` header; this
closes the IP-literal gap (OkHttp never hands a literal host to `GuardedDns`) at the transport level. The guarded
`OkHttpClient` (`guardedOkHttpClient`) sets `Proxy.NO_PROXY`, `followRedirects(false)` (both at the
OkHttp engine level AND Ktor's own client-side `HttpRedirect` plugin — `followRedirects = false` and the
`HttpTimeout` in `infra/outbound/GuardedKtorClient.kt` — checking-then-following would defeat the address check either way),
`retryOnConnectionFailure(false)`, no cookies, no proxy authenticator. A consumer layers a **bounded response read** (a byte cap, plus a structural
node and depth ceiling checked before a JSON parse, so a hostile host cannot cost a heap-sized tree or a `StackOverflowError`) and exponential backoff
with jitter on top; Flow's `fetch/SourceHttp.kt` is the donor shape. Every guard rejection is audited as
`outbound.blocked` (scheme + host ONLY — never the full URL, which may embed a token). **A DNS failure is NOT a guard
rejection**: when the resolver throws `UnknownHostException` or answers with no address for an ALREADY allow-listed host,
`GuardedDns` throws a plain `UnknownHostException(host)` (never a `BlockedHostException`), audits nothing and logs ONE WARN
(host only, no stack trace) — no security property is in play, and a lost DNS answer is routine on a VPN/forwarding resolver. It is an `IOException`, so a
consumer retries it with the normal backoff, and every retry re-runs the allow-list check and the resolve-check-connect sequence. The allow-list check still
runs BEFORE any resolution, so a disallowed host is never resolved. Pinned by `OutboundGuardTest`. The primary trust boundary for an upstream API is a
scoped, read-only credential, stored encrypted ("Encryption at rest" below).

**The Jira consumer (`jira/Jira.kt` `configureJira`, v1.1.0; donor Flow's `jira/Jira.kt`, same rules).** ONE guarded client (`buildGuardedJiraHttpClient`, the very function the tests build their client with) serves every connection, closed on `ApplicationStopped`, with:

- `allowedHost = isAllowedJiraHost(host, stubHost, developmentMode)` (`api.atlassian.com`, a genuine `*.atlassian.net` tenant by the SAME `JIRA_SITE_URL_PATTERN` + `ATLASSIAN_RESERVED_SITE_LABELS` the connection validation uses, `infra/outbound/AtlassianSites.kt` — the sync's allow-list now —, or in development the stub host);
- `addressAllowed` = `publicAddressesOnly`, plus the stub host in development, judged by Flow's rule (`jiraAddressRule` -> `isDevelopmentFixtureAddress`: loopback, or any address outside the never-admitted classes - link-local, any-local, multicast, `0.0.0.0/8`, `::/96`, NAT64 to a refused address or in `64:ff9b:1::/48`, 6to4, Teredo; a docker or private address is fine; an IP-literal `jira.stubBaseUrl` is judged by the same rule at boot: an IPv6 literal or a non-canonical numeric host such as `2852039166` is refused);
- `schemeFor` = the stub's own scheme for the stub host, else `https` (so `outbound.blocked` never claims a scheme that was not used);
- `originAllowed = isAllowedJiraOrigin` (`https` on 443 to an allowed host, or exactly the stub's origin in development: an IP-literal URL, a foreign port or plain http to a tenant is refused and audited);
- no proxy, no redirects, no retry at the OkHttp layer.

**A stored site URL cannot steer the traffic**: the connection's `siteUrl` (validated at write time) is only ever asked for the unauthenticated `GET /_edge/tenant_info`; every authenticated call goes to the gateway `https://api.atlassian.com/ex/jira/{cloudId}/…` (the stub host in development, same path shape), the cloud id is validated as a UUID before it is stored or spliced into a path, a Jira-supplied issue id or key is checked against `^[0-9]{1,20}$` / the key pattern before it joins a path, and a stored site that no longer has the genuine tenant shape is refused (`BLOCKED_HOST` row) before any client is built.

**`jira.stubBaseUrl`** (`$JIRA_STUB_BASE_URL`, `http(s)://host[:port]` and nothing else — a malformed value refuses boot in any mode, naming the key and never the value) reroutes BOTH hosts of a `stub-` site to a Jira stub (`jira/JiraStubRouting.kt`: `isJiraStubSite` = the tenant label starts with `stub-`; every other site reaches Atlassian even with a stub configured; the test result and the connection response carry `stub`, the audit line `jira.connection_tested` too); a non-blank value outside development mode refuses startup, so production can never reach one (`JiraBootTest`: the refusal, and "in production no loopback host is reachable, the stub's included").

**The other keys** (`jira.requestTimeoutSeconds` 5..120, `requestDeadlineSeconds` 10..600, `maxResponseBytes` 64 KiB..16 MiB, `maxConcurrentRequests` 1..8, `maxRetries` 0..8, `pageSize` 1..500, `incrementalOverlapMinutes` 0..1440, `censusHours` 1..168: the 1.4 census's child-level re-listing, a typed read with the stored token on the poll like the run's others) are boot-validated through `requireConfigInt`/`requireConfigLong`, and `jira/JiraHeapFit.kt` (Flow's heap-fit check, cut to what Astrolabe keeps) refuses the boot when `maxResponseBytes` and `maxConcurrentRequests` do not fit the JVM's old generation: one big parsed tree (112 B a node, the node ceiling of the cap) + the other in-flight trees below the 1 MiB lock threshold + every in-flight body + a 96 MiB reserve (the defaults need 174 MiB of the shipped `-Xmx256m -Xmn64m` JVM's 192 MiB; 16 MiB x 8 is refused; the 112 B and the reserve are Flow's measurements, not yet re-measured here).

**Response handling.** The client trims each big response INSIDE the transport's transform (`fields()` and `issueTypes()` return only the rows the mapping uses), so a parsed tree never outlives its call and the one-big-tree-at-a-time invariant of `SourceHttp` holds across the probes. The project probe asks `project/search` for exactly the connection's keys (`keys=A&keys=B`, at most 50, assumption A8) instead of paging a site's whole project list.

**The token** exists in memory only inside `HttpJiraClient`'s `Authorization` value and the `JiraTestTarget` the connector is handed (both mask it; `toString` pinned by `SecretToStringTest`), is decrypted by exactly three readers (`JiraConnectionService.readForTest` for the Test connection, `readForPeek` for Peek, `readForBind` for the bind and the two import routes - the paths a non-ADMIN can trigger, each only after its up-front authorization - and for the sync run, a further CALLER of the same reader: an ADMIN's manual run, or the scheduler) and never reaches a URL, a log line, an audit line, a problem body or a probe row; a `FetchException` message carries the host-and-path endpoint WITHOUT its query string, and the decrypt-failure log names the exception class only.
  A stored token that cannot be decrypted (`AEADBadTagException` after a key change; a non-rotating boot never test-decrypts) is a typed `TOKEN_UNREADABLE` probe row, not a 500.

**No database transaction spans an HTTP call**: the stored target is read in its own transaction, the outcome recorded in another. Test connection never answers 502 (every failure is a row) and rides the per-IP `jira-test` bucket (10/min by default; configurable, see the per-IP bucket paragraph).

**The outbound permit pool of Jira is one for the process** (`jira.maxConcurrentRequests`, the number the heap-fit check sized the heap on; nothing in Jira's path adds a permit - the process has a second, separate pool for Flow, bounded by its own tight keys, see "The Flow consumer"): a call's deadline clock starts BEFORE it queues for its first permit, so a saturated pool fails the call `TIMEOUT` instead of parking it for ever, and the bind (the one path a plain USER drives) carries a `PermitWait` of `jira.bindPermitWaitMillis` (`JIRA_BIND_PERMIT_WAIT_MILLIS`, default 5 s): a bind that cannot get a permit in that time answers the same `502` upstream problem with the code `BUSY` (words in `jira.errorCode.BUSY`), so a burst of binds cannot hold an administrator's Test connection behind them. `BUSY` cannot reach a run or a probe row (neither sets a `PermitWait`), so it is not in the run code list. Pinned by `PermitContentionTest` and, at the route, `JiraBindBusyTest`.

Also pinned by `OutboundGuardTest` (the production-wiring cases against the loopback `JiraStubServer`: `BLOCKED_HOST` after exactly one attempt, a disallowed host never resolved, `NO_PROXY`, a 3xx never followed, the DNS-failure cases, no leaked connection), `JiraBootTest`, `JiraClientTest` and `JiraTestConnectionTest` (no log line carries the token or its Basic header).

**Operator allowance for a private host (donor: Flow's self-managed GitLab).** A self-hosted upstream usually lives on a private address, which the guard refuses
by design. `infra/outbound/SelfManagedHosts.kt`, `Cidr.kt` and `CaBundle.kt` (ported from Flow; their consumer is the Flow sync, "The Flow consumer" below) widen it
for ONE connector from OPERATOR configuration only (never from anything a user or admin types): exact lowercase hosts (no wildcards, no IP literals, no
credentials in a config value), CIDRs a listed host may resolve to (boot refuses `/0`, IPv4 wider than /8, IPv6 wider than /32 and anything overlapping
loopback, link-local — the cloud metadata address `169.254.169.254` — any-local, multicast, 6to4, Teredo, IPv4-mapped or NAT64 space), a request-origin check
(`https` to a listed `host[:port]` only), and an optional extra CA bundle added ALONGSIDE the JVM defaults (no skip-TLS or trust-all switch anywhere). Pinned by
`SelfManagedHostsTest`; in k8s the egress NetworkPolicy still excludes private ranges, so such a host needs its own egress rule (the policy is the second layer,
the guard the first).

**The Flow consumer (`flow/Flow.kt` `configureFlow`, `infra/outbound/FlowOrigins.kt`, v1.5.0 C3).** Flow (the sibling app) is read through its read-only service token (`GET /api/v1/integration/me` and `/teams`, bearer `flow_int_` + 43 base64url characters). It is a PRIVATE address for the Flow of this deployment, so the allowance above is wired with a development-only extension, all of it OPERATOR configuration (`flow.*`, boot-validated, naming the key and never the value): `flow.allowedHosts` / `flow.allowedCidrs` / `flow.caBundle` (`FLOW_ALLOWED_HOSTS` / `FLOW_ALLOWED_CIDRS` / `FLOW_CA_BUNDLE`: the production path for a TLS Flow, https to a listed `host[:port]`, a private range only for a listed host inside a CIDR, an extra CA alongside the JVM defaults), and `flow.insecureOrigins` (`FLOW_INSECURE_ORIGINS`, exact `http://host[:port]` origins, no IP literal, default port 80): the Flow stub and a plain-http Flow on OrbStack (`http://flow-app:8084` on compose through the committed `docker-compose.real-flow.yaml` override, which joins Flow's network `flow_default`; `http://app.flow.svc.cluster.local:8084` in the cluster; `host.docker.internal` is NOT usable there, its address `0.250.250.254` is in the never-allowed `0.0.0.0/8`).

**A non-blank `flow.insecureOrigins` outside development mode refuses startup** (the `jira.stubBaseUrl` rule: `FlowBootTest`), and `FlowOrigins` ignores the list outside development mode as defence in depth.

**An insecure host may resolve to a loopback, private or docker-network address, and to nothing else**: its addresses are refused when they are link-local (the cloud metadata address `169.254.169.254` included), any-local, multicast, in `0.0.0.0/8` or `::/96`, NAT64 to a refused address or in `64:ff9b:1::/48`, or 6to4/Teredo (the `isNeverAllowed` classes minus loopback; `FlowOriginsTest`), and a host that is ALSO a listed TLS host follows the listed-host rule only (never loopback, whatever the CIDRs say). The host check still gates WHICH hosts are reachable.

**A connection's `baseUrl` must be exactly one listed origin in its canonical form** (`FlowOrigins.baseUrlVerdict`: `scheme://host[:port]`, lowercase scheme and host, the scheme's default port omitted, no path, trailing slash, query or credentials; the verdict is `ALLOWED`, `NOT_CANONICAL` or `NOT_LISTED` and the 400 names which, never quoting the value; wired through the composition root `infra/db/Database.kt`, which fails closed until `configureFlow` has built the rule), so an admin can never widen the list and every origin has one spelling.

**The list is disclosed to ADMIN** (`GET /api/v1/integrations/flow/origins`, `FlowOrigins.allowedOrigins()`, the donor's `allowedOrigins`): it is operator configuration validated host-shaped at boot (no credential, no path), shown only to the role that already reads every connection URL, and knowing it widens nothing (the guard judges every call).

A stored `baseUrl` is judged AGAIN by the transport on every call, so one the operator has since delisted is refused (`BLOCKED_HOST`, audited once, before any DNS lookup, no retry: `FlowBootTest`, `OutboundGuardTest`); the guarded client likewise refuses an IP-literal URL, a foreign port, plain http to a TLS host or a caller-set `Host` header (`outbound.blocked`).

The client is the same `guardedOkHttpClient`/`guardedKtorClient` pair (no proxy, no redirects — a 3xx is `REDIRECT` — no OkHttp-level retry) with the operator's CA bundle when set, ONE for the process, closed on `ApplicationStopped`, over `infra/fetch/SourceHttp` (`FlowHttp.kt`; its own `OutboundPermits` and so its own big-parse lock).

The numeric keys are bounded: `requestTimeoutSeconds` 5..120, `requestDeadlineSeconds` 10..600 (default 60), `maxResponseBytes` 64 KiB..1 MiB (default 1 MiB), `maxConcurrentRequests` 1..2 (default 1), `maxRetries` 0..8, `sprintsSinceDays` 30..1095.

**The heap arithmetic, and why there is no second heap-fit check.** The process has TWO permit pools and TWO big-parse locks (one `SourceHttp` per connector), and the sum stays bounded because each pool is bounded by its own keys: Jira's by `JiraHeapFit` (boot refuses a configuration that does not fit), Flow's by bounds tight enough that NO configuration can exceed the 96 MiB reserve `JiraHeapFit` keeps for what is not Jira's. Using that model (112 B of tree per node, one node per 8 wire bytes, `jira/JiraHeapFit.kt`): at the 1 MiB ceiling one Flow body is 1 MiB on the wire and at most 1 MiB / 8 = 131,072 nodes x 112 B = 14 MiB parsed, and a body of at most 1 MiB is below the transport's big-parse threshold, so Flow never takes its lock and two calls may parse at once: worst case 2 x (1 MiB + 14 MiB) = **30 MiB**, plus the decoded `FlowTeamsDocument`, which lives beside the tree until the decode returns (`HttpFlowClient.teams` decodes inside the transport's transform; avoiding that copy would mean bypassing the shared transport, so it is left; it is not measured here, and it holds the values, not a node per token). The defaults (1 MiB x 1) pin 15 MiB; the real document is about 150 KB. The ceilings are what make a second heap-fit check unnecessary. The 112 B and the reserve are Flow's measurements, not yet re-measured on Astrolabe.

**The token** exists in memory only inside `HttpFlowClient`'s `Authorization` value (and the decrypted `FlowConnectionTarget`, which masks it; both request and target are in the log-hygiene class list), is decrypted by `FlowConnectionService.readForTest` / `readForRun` only, and never reaches a URL, a log line, an audit line, a problem body or a failure message (a `FetchException` carries the host and path of the request, never a query).

Flow answers every authentication failure with ONE uniform 401 (revoked, expired, unknown, malformed): `AUTHENTICATION_FAILED`, never retried; a 500 is an outage (`UPSTREAM_UNAVAILABLE`, retried with backoff), a 404 a Flow older than 1.57.0 (`NOT_FOUND`), a 429 `RATE_LIMITED`.

**The contract has one Kotlin home**, `flow/FlowDocument.kt` (paths, query name, every field; `ignoreUnknownKeys`), twin of the stub's `sample-data/flow/contract.mjs`. The decoder is strict where an absence would read as a value: a missing `items`, `members`, `sprints`, `sprintsSince`, `teamsTruncated`, `sprintsTruncated` or `hasCalendar` is `INVALID_RESPONSE` (drift is visible, never "empty" or "false"); only the scalars that may be null default to null, because Flow encodes without defaults and so OMITS a null. `teamsTruncated` (the 1,000-team cap) and `sprintsTruncated` (2,000 sprints) are carried for the run to WARN and not to treat an absent team as gone.

In k8s the egress NetworkPolicy still excludes private ranges: `k8s/local/flow-egress.yaml` allows `app` to the `flow` namespace on TCP 8084 (the policy is the second layer).

Pinned by `FlowOriginsTest` (listed https, development http, production refusal, loopback for an insecure host in development only, the address classes, the CIDR rule, the canonical form), `FlowBootTest` (every refusal and bound, the published client and connector against the in-JVM stub, the delisted stored URL, the registry's predicate), `FlowClientTest` (MockEngine: the bearer header, 401/404/500/429, no redirect, the byte cap, the truncation flags, the strict and lenient decode, the stub's documents against `expected.json`) and the Flow cases of `OutboundGuardTest`.

What pins the transport: `OutboundGuardTest` (the allow-list, every blocked address range, the DNS-failure rule, the injectable address rule, the audit line) runs without a network. `OutboundTransportTest`
(a LOCAL socket server holding the rest of a 10 MB body to prove the response/connection release `prepareRequest {}.execute {}` — a 503 surfaces promptly, an oversized body
is a limit error, the server sees the client close the socket — plus a negative control showing the old `client.request()` pattern times out) came back with the bounded-read transport
(`infra/fetch/SourceHttp`, v1.1.0 C1), which it drives through `guardedKtorClient`. `DirectSocketFactory` (in `OutboundGuard.kt`): every self-resolving `createSocket` overload is refused; its socket never consults the JVM
`ProxySelector`, and the guarded client connects to exactly the address `GuardedDns` returned. `fastFallback(false)` is a configuration assertion by choice: its effect only shows with several
resolved addresses and a slow earlier one, which loopback cannot stage without timing races. `AtlassianSites.kt` and `isAllowedJiraHost` are the Jira sync's allow-list (above).

**CORS is off by default** (`plugins/Http.kt`): the plugin is installed only when
`http.corsHosts` (`$CORS_ALLOWED_HOSTS`, comma-separated hosts) is non-empty. Production is
single-origin (Ktor serves the SPA) and dev goes through the Vite proxy, so no cross-origin caller
exists by default — no `anyHost()`. **Reverse proxy**: set `HTTP_BEHIND_PROXY=true` (config
`http.behindProxy`) when TLS terminates at an ingress/proxy — it installs `XForwardedHeaders`,
configured to honour ONLY the canonical `X-Forwarded-Host`/`X-Forwarded-Proto` (Ktor's defaults
also read `X-Forwarded-Server`/`X-Forwarded-Protocol`/`X-Forwarded-SSL`/`Front-End-Https`, which a
proxy that sets just the canonical ones passes through from the client untouched — Lettuce's
v3.6.2 finding, ported) and never `X-Forwarded-Port` (a client-supplied non-numeric value used to
throw a 500 out of `CallSetup` before any route ran; nothing reads it, since the scheme-derived
default port is all the HTTPS redirect needs), so rate-limit buckets key on the real client IP and
the HTTPS redirect sees the real scheme; the proxy must set (and strip client-supplied)
`X-Forwarded-For`/`X-Forwarded-Proto`. **`X-Forwarded-For` is folded before Ktor ever reads it**:
Ktor's `XForwardedHeaders` resolves a for-header via `Headers.get(name)` — the FIRST header LINE
only — so a proxy that APPENDS a fresh `X-Forwarded-For` line instead of merging into one the
client already sent (HAProxy's `option forwardedfor`) would leave the client-supplied first line as
the trusted value. `resolveForwardedForOrigin` (`plugins/Http.kt`) runs at the `Setup` phase —
strictly before `XForwardedHeaders`' own `Plugins`-phase `onCall` — reads every
`X-Forwarded-For` header line via `getAll`, folds them into one hop-ordered list (RFC 2616: same-
name header fields may be combined by joining their values with a comma, in the order received),
and resolves the trusted hop itself directly into the call's `MutableOriginConnectionPoint`;
`XForwardedHeaders` is then configured with an empty `forHeaders` so it never overwrites that
result with its own unfolded, first-line-only read. The hop selection itself is unchanged: read
from the END of the combined list, keyed on `HTTP_PROXY_HOPS` (config `http.proxyHops`,
boot-validated ≥ 1 via `requireConfigInt` — a config error, not a runtime concern): 1 (the default,
one TLS-terminating proxy that APPENDS) trusts the value the last proxy wrote; N skips the N-1
addresses trusted proxies appended after the client's — never the first value, which is
client-supplied and spoofable. A hop count in excess of what the request actually carries falls
back to the last available value (the same fallback Ktor's own `useLastProxy()`/
`skipLastProxies()` apply) rather than throwing. Off by default because honoring these headers
from direct clients lets them spoof both. Covered by `ForwardedHeadersTest`; the multi-line fold
itself needs a real Netty engine to pin (`RawForwardedForLinesTest` writes the raw HTTP/1.1
request by hand — ktor-client's own request writer folds repeated `header()` calls into one wire
line before send, so `testApplication`'s client cannot reproduce two genuinely distinct lines).

CSRF install is gated behind `security.csrf.enabled` (default **`false`** in `application.yaml`,
env-overridable via `SECURITY_CSRF_ENABLED`); the configured `originMatchesHost()` +
`allowOrigin("http://localhost:8086")` + `checkHeader("X-CSRF-Token")` combo is unsatisfiable from
both the Ktor test client and the dev SPA on `:5178`, and CSRF protection is anyway moot for this
app's bearer-JWT auth model — browsers do not auto-attach `Authorization` headers, so cross-site
forms cannot forge an authenticated request. Re-enable only if you move to cookie-based session
auth and fix the allow-list accordingly.

**Default admin.** Migration `V3__seed_admin.sql` inserts a single bootstrap administrator on
first boot: `admin@astrolabe.local` / `changeme` (role `ADMIN`), idempotent via `ON CONFLICT DO
NOTHING`. The migration is kept **unchanged** (dev + e2e depend on it; checksums must not change)
— production neutralizes it at startup via the bootstrap above. There are no demo seed users.
**Kubernetes secrets** live in the `astrolabe-secrets` Secret in the `astrolabe` namespace
(`k8s/secret.yaml` is a placeholder template — create the real one out-of-band with the
`kubectl create secret generic` command in its header; the `app` Deployment consumes it via
`secretKeyRef`).

**Probes and the plain-HTTP crash-loop** (`k8s/app-deployment.yaml`, ported from Toadie): every
probe (`startupProbe`/`readinessProbe`/`livenessProbe`) sends `X-Forwarded-Proto: https` — the
header the TLS-terminating ingress sets, which `HTTP_BEHIND_PROXY`/`HTTP_PROXY_HOPS` above makes
the app trust (under the local overlay the header is ignored, harmlessly — development mode never redirects). Without it, production mode answers the kubelet's plain-HTTP probe request with a
301 to `https://<pod-ip>/`, which the kubelet FOLLOWS (same host) into a refused `:443` — every
probe fails and the pod crash-loops (Lettuce's v3.6.1 incident, reproduced in production).
`startupProbe` (30 x 5s = ~150s) covers JVM boot + Flyway migrations before the liveness clock
starts, so a slow first boot cannot trigger a restart.

**Kubernetes pod and network hardening** (`k8s/*.yaml`, validated by ci.yml's `k8s-static`
job — `kubeconform -strict` over the raw manifests (`k8s/*.yaml`, `k8s/local/*.yaml`) and over what `k8s/apply-local.sh` renders):

- **Pods.** Both (`app`, `postgres`) set `automountServiceAccountToken: false` — nothing
  calls the Kubernetes API, so no token is mounted. `app`: uid 10001, `runAsNonRoot`, seccomp
  `RuntimeDefault`, read-only root filesystem (only `/tmp`; the AppCDS archive `/app/cds/astrolabe.jsa` is a root-owned 0444 file baked into the image and only ever read), no privilege escalation, `drop: [ALL]`.
  `postgres` runs the same way minus the read-only root filesystem: `runAsNonRoot` as the alpine image's
  own `postgres` user (**uid/gid 70** — 999 in the Debian image, so change `runAsUser`/`runAsGroup`/
  `fsGroup` together with the image variant), `fsGroup: 70` with `fsGroupChangePolicy: OnRootMismatch`,
  seccomp `RuntimeDefault`, `allowPrivilegeEscalation: false`, `drop: [ALL]` (a non-root start needs no
  capability: the entrypoint's chown/gosu step only runs as root). `readOnlyRootFilesystem` stays off for
  postgres — it writes its socket/lock files under `/var/run/postgresql` and temp files under `/tmp`.
- **Compose parity.** The compose `app` service carries the same container posture (`read_only: true` with a `/tmp` tmpfs, `cap_drop: [ALL]`, `no-new-privileges`); `postgres` and `mailpit` stay as shipped (the postgres entrypoint starts as root and needs setuid/chown capabilities).
- **`k8s/network-policies.yaml`.** `default-deny-all` (ingress AND egress for every pod in `astrolabe`), then:
  `postgres` accepts 5432 only from `app`; `app` accepts 8086 (the front door, below);
  `app` may egress to `postgres:5432`, to cluster DNS (kube-system `k8s-app=kube-dns`, 53
  UDP/TCP) and to public addresses on 443, 587/465/25 (SMTP) — RFC 1918,
  link-local (cloud metadata `169.254.169.254`) and CGNAT ranges excluded, so a compromised pod cannot
  reach other namespaces or cluster services. Things that need their own extra policy:
  an in-cluster/private SMTP relay, an OTLP collector (`OTEL_*_EXPORTER=otlp`; the default is console),
  any private upstream (the OrbStack overlay's Jira stub is one: `k8s/local/jira-stub.yaml` adds `allow-app-egress-to-jira-stub` and `allow-jira-stub-from-app`, app → `jira-stub:8080` only; the Flow stub is another, `k8s/local/flow-stub.yaml` with the same pair for `flow-stub:8080`, and `k8s/local/flow-egress.yaml` adds `allow-app-egress-to-flow`, app → namespace `flow` TCP 8084 for a real in-cluster Flow; the base never has any of them). **Cluster assumptions:** DNS is
  matched as pods labelled `k8s-app: kube-dns` in the `kube-system` namespace (stock CoreDNS); a
  NodeLocal DNSCache (link-local resolver address) or OpenShift (`openshift-dns` namespace, different
  labels) needs the DNS rule adjusted, or every lookup times out; SMTP submission on port 2525 and any
  IPv6 destination are not covered (the `ipBlock` is IPv4 only) and need their own rule. Enforcement needs a CNI that
  implements NetworkPolicy (OrbStack's local cluster does). A CNI that does not enforce leaves the objects inert, which is harmless. New
  pods take a few seconds to be programmed, so a very fast first connection can fail once — the
  `startupProbe` window absorbs it.
- **The front door (settled, 1.0.0).** Kubernetes is a LOCAL deployment target (OrbStack): `k8s/app-service.yaml` is a
  `LoadBalancer`, reached over plain HTTP. The `app` Deployment reads `KTOR_DEVELOPMENT`/`HTTP_BEHIND_PROXY`/`HTTP_PROXY_HOPS`
  from the ConfigMap `astrolabe-front-door`, and `k8s/apply-local.sh` applies the OVERLAY `k8s/local/front-door.yaml`
  (`KTOR_DEVELOPMENT=true`, `HTTP_BEHIND_PROXY=false`: development mode behind no proxy, so no HTTPS redirect, `/openapi`
  exposed, the burned/seed credentials tolerated and the `X-Forwarded-*` headers ignored; the real secrets still come
  from `astrolabe-secrets` and `ADMIN_INITIAL_PASSWORD` still rotates the seeded admin) INSTEAD of the base
  `k8s/front-door.yaml`. The base file stays the **production posture** for a TLS-terminating Ingress that sets and
  overwrites `X-Forwarded-For`/`-Proto` and is **unsafe behind a bare LoadBalancer**: plain HTTP gets the 301 to
  `https://`, and the headers are client-controlled, so the per-IP rate-limit key and the redirect skip are spoofable.
  Cost accepted: no deployment target runs production mode; only the server suite proves it (compose is development
  mode too). `allow-app-ingress` is unchanged on purpose: LoadBalancer traffic reaches the pod from outside the
  cluster, so no pod or namespace selector can name its source and the port is the restriction; a deployment that
  adds a TLS Ingress and a `ClusterIP` Service adds the controller's namespace selector there. A ConfigMap change
  does not restart the pod (the env is read when a container starts): `apply-local.sh`'s unique image tag rolls the
  pod on every run. CI (`k8s-static`) pins the base file to `"false"`/`"true"` and the rendered directory to exactly
  one `astrolabe-front-door` ConfigMap carrying the overlay.

**Log hygiene.** Every data class that carries a password, token, MFA code, password hash or signing key
(`LoginRequest`, `LoginResponse`, `MfaVerifyRequest`, `RefreshRequest`, `LogoutRequest`, `User`,
`UserCreateRequest`, `PasswordUpdateRequest`, `PasswordResetConfirmRequest`, `JiraConnectionRequest`, `JiraTestTarget`, `FlowConnectionRequest`, `FlowConnectionTarget`, `JwtConfig`, the MFA challenge types, `IssuedToken`)
overrides `toString()` and prints each secret
through `maskedSecret` (`infra/Secrets.kt`: `***`, or `null` when absent), so templating one into a log line or an
exception message never reveals it; a new secret-bearing class does the same. Pinned by `SecretToStringTest`. `infra/db/Flyway.kt`'s startup log line renders the operator-supplied JDBC URL
through `jdbcUrlForLogging()` — `host:port/db` only, no userinfo or query string — so a
`jdbc:postgresql://host/db?user=...&password=...` form never lands a credential in the log
(`.claude/docs/observability.md`, "never log secrets"); covered by `FlywayLogTest`. `POST
/api/v1/logout`'s malformed-body debug line (`auth/AuthRoutes.kt`) logs only the parse failure's
exception CLASS NAME, never the throwable — the cause chain can embed a body excerpt (kotlinx's
decode-error message), the same `errorType`-only rule as `login.mfa_send_failed`/
`password_reset.send_failed`; covered by `LogoutTest`.

**Outbound email** (`infra/mail/`, ported from Lettuce): `configureMail` (registered at the top of
the infrastructure group, before Flyway) publishes `MailerKey` holding a `Mailer` or null.
`mail.transport` (`$MAIL_TRANSPORT`) selects `log` (dev default — the full message, **including
reset links and MFA codes**, goes to the `ch.nokillswit.mail` logger; **production mode refuses to
start on it**), `smtp` (Jakarta/Angus Mail over `mail.smtp.*` / `$SMTP_HOST` etc.; a blank host
refuses startup in any mode), or `disabled` (the Docker image default via
`ENV MAIL_TRANSPORT=disabled` — email features answer 503 through `respondMailUnavailable`). The
compose demo wires `smtp` → the bundled Mailpit (`http://localhost:8029` — 8025–8028 belong
to sibling stacks); k8s ships `disabled` with `SMTP_USER`/`SMTP_PASSWORD` read (optional) from
`astrolabe-secrets`. Consumers: self-service password reset and email MFA. The recipient-language
content layer (`LocalizedText`) lives beside the transports; `mail.appUrl` is validated here too (above). Tests:
`MailTransportTest` (the transport matrix + both refusals + LogMailer delivery via the
`ch.nokillswit.mail` LogCapture); production-mode boot tests must override `mail.transport` with
`"disabled"`, since the dev-default `log` transport is refused in production.

**Encryption at rest** (`infra/crypto/`, Lettuce's, ported; the first consumer is `jira_connections.api_token`, V21, `jira/JiraConnectionService.kt` — the credential of the Jira deviation sync). Sensitive columns are encrypted application-side with AES-256-GCM (`FieldCipher`: a
fresh 12-byte nonce per value, 128-bit tag, envelope `enc:v1:<base64(nonce||ciphertext)>`), so a
database-level attacker — SQL access, `pg_dump`, a stolen volume or backup — sees ciphertext; the
key lives with the app (`DATA_ENCRYPTION_KEY`, 64 hex chars from `openssl rand -hex 32`; compose
ships a burned demo key, k8s reads `astrolabe-secrets`), never in the database. **Losing the key loses
every encrypted value** — back it up apart from the DB. Rotation: set the OLD key as
`DATA_ENCRYPTION_KEY_PREVIOUS` (decrypt-only fallback — a wrong-key attempt fails cleanly on GCM's
tag, then the previous key is tried) and the new one as `DATA_ENCRYPTION_KEY`, then re-encrypt every row under the
current key and remove the previous key. **The registry and the boot backfill** (Flow's, ported with the sync): a service owning encrypted columns implements `EncryptedAtRest` (`infra/crypto/EncryptedAtRest.kt`) and is listed in `encryptedAtRestServices()` in `infra/db/Bootstrap.kt` (never remove a registration once one lands — a rotation would strand that feature's rows; `EncryptedAtRestBootTest` fails an implementer that is not listed). At every boot the loop calls each service's `encryptLegacyRows(reencryptAll)`: without `security.encryption.previousKey` it wraps only rows still holding plaintext, with it it re-encrypts EVERY row (soft-deleted ones included) under the current key, through `Reencrypt.kt`'s `reencryptRows` — the ONE sanctioned SQL predicate over an encrypted column is its `notLike "enc:v1:%"`. A pass that touched rows logs one INFO line and the audit event `crypto.reencrypted` (`rows`, `label`, `rotating` — counts and a noun, never a value). A new rotation therefore ends with one boot under both keys, after which `DATA_ENCRYPTION_KEY_PREVIOUS` can be removed. **A rotation boot that meets an envelope neither key opens fails closed** (a `GeneralSecurityException` in the cause chain, the whole backfill is ONE transaction so no row was touched; keep that behaviour: a half-rotated table is worse than a refused boot). **Recovery, without printing a value:** do NOT change the keys again. (1) Boot once under the configuration the rows were last readable under (the pre-rotation `DATA_ENCRYPTION_KEY`, no previous key): that boot decrypts nothing. (2) Find the stranded rows: Test connection on each Jira connection answers `TOKEN_UNREADABLE` for exactly those, and the server logs `The stored API token of Jira connection <id> cannot be decrypted (<exception class>)` (an id, never an envelope); in SQL `SELECT id, name, marked_as_deleted, updated_at FROM jira_connections ORDER BY id` lists the rows without touching the column. (3) For each: edit the connection and enter its token again (a present token is encrypted under the current key), or delete it (a delete sets it NULL, below). Only an ACTIVE row can be stranded: a delete writes NULL, which a rotation skips, so a deleted connection never blocks one. (4) Rotate again: previous = the old key, current = the new one, one boot. **A stored token is only ever an envelope (or, on a deleted row, NULL):** V21's `ck_jira_connections_api_token` (`api_token IS NULL OR api_token LIKE 'enc:v1:%'`) and `ck_jira_connections_api_token_live` (`marked_as_deleted OR api_token IS NOT NULL`) make the database refuse a plaintext value and a tokenless active row, so the boot backfill's plaintext wrap can no longer fire on this table (its code path is proven on a throwaway table and stays for the next encrypted column). **A deleted connection keeps no credential, literally:** `JiraConnectionService.delete` sets `api_token` to NULL in the delete's own transaction, so no secret sits at rest and no envelope under an old key is left for a later rotation to open (`reencryptRows` skips NULLs); `readForTest`/`readForPeek`/`readForBind` read ACTIVE rows only (`JiraConnectionTest`, `JiraSchemaTest`). A run already in flight when the connection is deleted ends `CONNECTION_GONE` before its next page, so a token copy in memory authenticates no further read. **Never filter or sort on an encrypted column in SQL** — ciphertext carries no order or equality (every value has its own nonce).
**The second consumer** is `flow_connections.api_token` (V24, `flow/FlowConnectionService.kt`: Flow's read-only service token), decrypted by `readForTest` and `readForRun` only; a decrypt failure reads as a null token, never an exception. **Jira business text is plaintext by design** (issue summaries, keys, points, observations): only credentials are encrypted. The V23 census mirror `jira_issues` (1.4) widens that to every in-scope issue, unbound stories included, and keeps a summary (control characters replaced by spaces) it never emits: no endpoint exposes mirror summaries (1.4 lists only keys and counts) and no log line names one.
A credential column is write-only end to end: accepted on create/update, never returned, never in an audit line or a log line (the response carries a `has…` boolean instead), and **never decrypted on a read path** — `JiraConnectionService` encrypts and re-wraps on every write path, and it has exactly THREE decrypting methods (`JiraTestRecorder` and `JiraMappingStore`, split out of it, never select or see the token); each handing the plaintext to the connector that calls Jira and nothing else: `readForTest` (Test connection, ADMIN), `readForPeek` (Peek, ADMIN) and `readForBind` (the bind, v1.1.0 C5; the sync run of C6 calls this same reader, so it adds a caller, not a decrypting path). `sync/` never sees the credential column either: `ConnectionColumns` (`sync/ConnectionRegistry.kt`) deliberately has no token column, so the shared run-state and poll-row helpers cannot select it. **The bind and the two import routes are the decrypting paths a non-ADMIN can trigger** (any owner of a plan node may bind or preview/apply an import): the token still never leaves the process - it only builds the `Authorization` header of the Jira reads - and the caller learns only what those reads show (`authorization.md`), behind the per-user `jira-bind` / `jira-import` bucket. **A caller refused by the up-front checks never makes the server decrypt:** the import routes check the connection's existence with the non-decrypting `runnableState` (`404`), and call the decrypting `readForBind` only after the named-target `404`s and the up-front `403`s (`JiraImportRoutes.admit`), so a login that owns no plan node - or names a default it does not own - gets its `403` with the ciphertext untouched (the preview's resolved-target `403` and the apply's under-the-lock `403` still come after the decrypt and the browse, the deliberate cost `authorization.md` records) (`JiraImportDecryptOrderTest`: an undecryptable envelope leaves one "cannot be decrypted" WARN per decrypt, none for a refused caller). A run's stored failure text is URL-free for the same reason it is token-free: `JiraObserver` writes `Jira fetch failed: {code} ({status})`, never the exception message, whose endpoint `clampErrorDetail` is only the backstop for (`JiraRunFailureTest` reads it back through `GET /integrations/sync/runs`). A decrypt failure reads as a null token and a typed `TOKEN_UNREADABLE` row (Test) or a `409` (Peek, bind, the import routes). An update that omits the token (or sends a blank one) keeps the stored envelope byte for byte; a present one replaces it.
Tests: `FieldCipherTest` (roundtrip, fresh nonces, legacy passthrough, tamper, wrong key, rotation, malformed keys), `CryptoBootTest`, `EncryptedAtRestBootTest` (a plaintext value wrapped once by the backfill body on a throwaway table, a rotation boot that moves every row and then hands the suite's key back, the registration scan), `JiraConnectionTest` (the stored envelope, keep/rotate, no token in a response, problem body, audit or log line; the credential NULLed on delete), `JiraSchemaTest` (the CHECKs refuse plaintext and a tokenless active row).

**Trusted PostgreSQL extensions.** `unaccent` (V4) is a contrib extension trusted since PG13: `CREATE EXTENSION IF NOT EXISTS` needs only `CREATE` on the
database, no superuser. A future `btree_gist` (overlap-exclusion constraints, e.g. effective-from capacity periods) is the same class.

### Telemetry

`telemetry/` (`observability.md` "Telemetry") records Astrolabe's own vital signs into `ops.*` and serves them to ADMINs only (`GET /api/v1/telemetry/current`
and `/history`, `authorization.md`; per-user bucket `telemetry`, 30/min). What it discloses, and to whom — every ADMIN, nobody else (a USER gets the
uniform `403`):

- **Process identity:** the role (the constant `app`), the pod / host name (`HOSTNAME`, up to 100 control-free characters), the JVM start, the image's build version and
  commit, the processor count, the heap maximum and the container memory limit - and the live memory, CPU, thread, GC and connection-pool figures.
  NEVER JVM arguments, environment variables, system properties, request paths with identifiers or any project data (pinned: the `ops` tables hold
  numbers and these labels only).
- **Route usage:** the normalised API routes (`/api/v1/users/{id}`, path parameters as written, never an identifier) with their request counts,
  latencies and 5xx / 429 counts. The telemetry routes themselves and the probes are excluded.

**Metric-name cardinality is bounded.** Ktor's `DropwizardMetrics` (3.6) names a meter after `request.uri` - query string included - for every response it
could not route and for every second response of a call (the StatusPages re-answer of the RateLimit plugin's bodiless `429`, routing's `405`), and a
registered Dropwizard instrument is never evicted: an unauthenticated client (`POST /api/v1/login?x=<random>` past the login bucket, random unrouted
paths or methods) could mint one meter per distinct URI until the heap is gone, and the periodic `Slf4jReporter` would print each of them, query
strings included. So `plugins/Monitoring.kt`'s `TelemetryRegistry` registers NO `ktor.calls.` name containing a `?` (the caller gets a detached,
unregistered instrument), caps the whole `ktor.calls.` family at 2,000 registered names (past it: detached instruments and one WARN), and the reporter
filters out any name with a `?` as defence in depth. Pinned by `TelemetryRegistryTest` (a flood of unrouted, 405 and rate-limited requests with varying
query strings registers none). The sampler reads the registry's timers and meters only, so detached instruments cost it nothing.

### Not yet ported

Nothing remains on the security list beyond the forward SSRF guidance above; new subsystems
arrive with their own section here.
