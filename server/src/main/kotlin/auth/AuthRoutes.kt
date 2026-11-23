package ch.nokillswit.auth

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.TooManyRequestsException
import ch.nokillswit.authz.UnauthorizedException
import ch.nokillswit.infra.config.requireConfigInt
import ch.nokillswit.infra.config.requireConfigLong
import ch.nokillswit.infra.mail.mailer
import ch.nokillswit.plugins.JwtConfig
import ch.nokillswit.plugins.JwtConfigKey
import ch.nokillswit.users.Feature
import ch.nokillswit.users.User
import ch.nokillswit.users.UserServiceKey
import ch.nokillswit.users.additionalRoles
import ch.nokillswit.infra.validation.canonicalEmail
import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.*
import io.ktor.server.auth.authenticate
import ch.nokillswit.plugins.RateLimits
import io.ktor.server.plugins.ratelimit.RateLimitName
import io.ktor.server.plugins.ratelimit.rateLimit
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import io.ktor.server.routing.routing

/**
 * The upper bound for the lockout/reset/MFA durations configured in SECONDS (before their `* 1000` millis conversion):
 * a value near `Long.MAX_VALUE` would overflow into a negative millis figure and silently DISABLE the lockout/throttle
 * instead of refusing to start. 30 days is far beyond any legitimate value.
 */
internal const val MAX_DURATION_SECONDS = 30L * 24 * 3600

/** Ceiling for the in-memory throttle/challenge stores' `maxTracked` capacities — bounds the memory an operator can commit. */
internal const val MAX_TRACKED_IDENTITIES = 1_000_000

internal fun JwtConfig.authResponse(userId: UInt, user: User): LoginResponse {
    val roles = user.additionalRoles
    val access = issueAccessToken(userId, user.email, roles, user.disabledFeatures, user.credentialRevision)
    val refresh = issueRefreshToken(
        userId,
        user.email,
        roles,
        user.disabledFeatures,
        user.credentialRevision,
    )
    return LoginResponse(
        token = access.token,
        expiresAt = access.expiresAt,
        refreshToken = refresh.token,
        refreshExpiresAt = refresh.expiresAt,
        userId = userId,
        roles = roles.sortedBy { it.name },
        disabledFeatures = user.disabledFeatures.sortedBy { it.name },
        // Not a JWT claim: the SPA reads it from this response, and emails read it fresh
        // at send time — nothing needs it inside the token.
        language = user.language,
    )
}

/** What every auth handler reaches for — built once by [configureAuthRoutes], handed to the route functions below. */
internal class AuthDeps(
    val jwtConfig: JwtConfig,
    val userService: ch.nokillswit.users.UserService,
    val blocklist: TokenBlocklistService,
    val loginThrottle: LoginThrottle,
    val mailer: ch.nokillswit.infra.mail.Mailer?,
    val mfaChallenges: MfaChallenges,
    val mfaTtlMinutes: Long,
    /** Verifies signature/issuer/audience/expiry of a presented refresh token — the same secret as the access verifier. */
    val refreshVerifier: com.auth0.jwt.JWTVerifier,
)

fun Application.configureAuthRoutes() {
    val jwtConfig = attributes[JwtConfigKey]
    // Boot-validated through the shared requireConfigInt/requireConfigLong (Lettuce's ranges,
    // ported) below: a malformed or out-of-range value is a config error, not a runtime concern —
    // e.g. LOGIN_LOCKOUT_THRESHOLD=0 would lock out every account on its first attempt.
    // codeTtlSeconds is validated with min = 0 ONLY in development mode (not Lettuce's min = 1): Astrolabe's
    // in-memory MfaChallenges (unlike Lettuce's DB-backed table) has no back-dating hook for
    // `MfaLoginTest`'s "an expired challenge answers the same uniform 401" case, which mints a
    // deliberately born-expired challenge via codeTtlSeconds=0. Outside development a zero TTL would
    // silently make every MFA login fail, so it refuses startup. The upper bound guards the *1000 overflow.
    val mfaTtlSeconds = requireConfigLong(
        environment.config, "security.mfa.codeTtlSeconds", min = if (developmentMode) 0 else 1, max = MAX_DURATION_SECONDS,
    )
    val deps = AuthDeps(
        jwtConfig = jwtConfig,
        userService = attributes[UserServiceKey],
        blocklist = attributes[TokenBlocklistServiceKey],
        // Per-account lockout, complementing the per-IP bucket (which rotating hosts sidestep):
        // N consecutive failures for one email → locked for the configured window.
        loginThrottle = LoginThrottle(
            threshold = requireConfigInt(environment.config, "security.lockout.threshold", min = 1),
            // Bounded above (30 days) as well as below: an unbounded value survives the *1000
            // millis conversion right up until it doesn't — a durationSeconds near Long.MAX_VALUE
            // overflows into a negative millis figure, which would silently DISABLE the lockout
            // instead of refusing to start.
            lockoutMillis = requireConfigLong(
                environment.config, "security.lockout.durationSeconds", min = 1, max = MAX_DURATION_SECONDS,
            ) * 1000,
            maxTracked = requireConfigInt(environment.config, "security.lockout.maxTracked", min = 1, max = MAX_TRACKED_IDENTITIES),
        ),
        mailer = mailer(),
        // Email MFA: pending challenges for MFA-enabled accounts mid-login. In-memory, per-instance,
        // like the throttles above. The issuance worker lives beside the email content (auth/MfaEmail.kt).
        mfaChallenges = MfaChallenges(
            ttlMillis = mfaTtlSeconds * 1000,
            maxAttempts = requireConfigInt(environment.config, "security.mfa.maxAttempts", min = 1, max = 100),
            maxTracked = requireConfigInt(environment.config, "security.mfa.maxTracked", min = 1, max = MAX_TRACKED_IDENTITIES),
            maxLivePerAccount = requireConfigInt(environment.config, "security.mfa.maxLivePerAccount", min = 1, max = 100),
        ),
        mfaTtlMinutes = (mfaTtlSeconds + 59) / 60,
        refreshVerifier = JWT.require(Algorithm.HMAC256(jwtConfig.secret))
            .withAudience(jwtConfig.audience)
            .withIssuer(jwtConfig.issuer)
            // Rotation blocklists the jti until the token's own expiry, so an exp-less token is malformed.
            .withClaimPresence("exp")
            .build(),
    )
    // The buckets are installed by plugins/RateLimits.kt; each public step rides its own.
    routing {
        rateLimit(RateLimitName(RateLimits.LOGIN)) { login(deps) }
        rateLimit(RateLimitName(RateLimits.MFA)) { mfa(deps) }
        rateLimit(RateLimitName(RateLimits.REFRESH)) { refresh(deps) }
        authenticate { logout(deps) }
    }
}

private fun loginAuditIdentity(email: String): Pair<String, Any?> =
    if (email.length <= 254) "email" to email else "emailDigest" to loginIdentityKey(email)

private fun Route.login(deps: AuthDeps) {
    val jwtConfig = deps.jwtConfig
    val userService = deps.userService
    val loginThrottle = deps.loginThrottle
    val mailer = deps.mailer
    val mfaChallenges = deps.mfaChallenges
    val mfaTtlMinutes = deps.mfaTtlMinutes
    post("/api/v1/login") {
        val req = call.receive<LoginRequest>()
        // Canonical identity: accounts are stored under the folded email, so the login
        // lookup folds the same way — a padded or case-variant submission matches its
        // account (and keeps sharing one lockout bucket).
        val email = canonicalEmail(req.email)
        val auditIdentity = loginAuditIdentity(email)
        when (loginThrottle.preflight(email)) {
            LoginThrottle.Preflight.ALLOWED -> Unit
            LoginThrottle.Preflight.LOCKED -> {
                audit(EVENT_LOGIN_REJECTED_LOCKED, auditIdentity)
                // Thrown (not respondProblem) so StatusPages marks the call handled and its
                // generic 429 status handler cannot replace this specific detail.
                throw TooManyRequestsException(
                    "Too many failed login attempts for this account — try again later",
                )
            }
            LoginThrottle.Preflight.CAPACITY_EXCEEDED -> {
                audit(EVENT_LOGIN_CAPACITY_REJECTED, auditIdentity)
                throw TooManyRequestsException("Too many sign-in identities are being tracked — try again later")
            }
        }
        val record = userService.findWithIdByEmail(email)
        // The unknown-email branch pays a full (discarded) bcrypt verify so its latency
        // matches the wrong-password branch — without it the fast 401 is a timing oracle
        // for account enumeration (the reset path equalizes the same way, via async work).
        val credentialsValid =
            if (record == null) {
                verifyPassword(req.password, TIMING_EQUALIZER_HASH)
                false
            } else {
                verifyPassword(req.password, record.second.passwordHash)
            }
        if (record == null || !credentialsValid) {
            val failureResult = loginThrottle.recordFailure(email)
            when (failureResult) {
                LoginThrottle.FailureResult.CAPACITY_EXCEEDED -> {
                    audit(EVENT_LOGIN_CAPACITY_REJECTED, auditIdentity)
                    throw TooManyRequestsException("Too many sign-in identities are being tracked — try again later")
                }
                LoginThrottle.FailureResult.ALREADY_LOCKED -> {
                    audit(EVENT_LOGIN_REJECTED_LOCKED, auditIdentity)
                    throw TooManyRequestsException(
                        "Too many failed login attempts for this account — try again later",
                    )
                }
                LoginThrottle.FailureResult.RECORDED,
                LoginThrottle.FailureResult.LOCKED_NOW,
                -> Unit
            }
            audit(
                "login.failure",
                auditIdentity,
                "reason" to if (record == null) "unknown_email" else "wrong_password",
            )
            if (failureResult == LoginThrottle.FailureResult.LOCKED_NOW) {
                audit("login.lockout", auditIdentity)
            }
            throw UnauthorizedException("Unknown email or wrong password")
        }
        val (userId, user) = record
        if (loginThrottle.recordSuccess(email) == LoginThrottle.SuccessResult.LOCKED) {
            audit(EVENT_LOGIN_REJECTED_LOCKED, auditIdentity)
            throw TooManyRequestsException(
                "Too many failed login attempts for this account — try again later",
            )
        }
        // Email MFA (opt-in via the MFA feature flag, read straight off the DB record —
        // no JWT exists yet): correct credentials answer with a challenge, not tokens.
        if (Feature.MFA !in user.disabledFeatures) {
            issueMfaChallenge(call, mfaChallenges, mailer, mfaTtlMinutes, userId, user)
            return@post
        }
        audit("login.success", "email" to user.email, "userId" to userId.toLong())
        call.respond(HttpStatusCode.OK, jwtConfig.authResponse(userId, user))
    }
}

private fun Route.mfa(deps: AuthDeps) {
    val jwtConfig = deps.jwtConfig
    val userService = deps.userService
    val mfaChallenges = deps.mfaChallenges
    // Second login step for MFA-enabled accounts: exchange the challenge id + the
    // emailed code for the ordinary token pair. Not behind `authenticate` — there is
    // no token yet.
    post("/api/v1/login/mfa") {
        val req = call.receive<MfaVerifyRequest>()
        when (val outcome = mfaChallenges.verify(req.challengeId, req.code)) {
            is MfaChallenges.Outcome.Failure -> {
                audit(EVENT_LOGIN_MFA_FAILURE, "reason" to outcome.reason)
                // Uniform for every failure mode — a guesser learns nothing about
                // whether the challenge exists, expired, or the code was wrong.
                throw UnauthorizedException("Invalid or expired sign-in code")
            }
            is MfaChallenges.Outcome.Success -> {
                val userId = outcome.userId
                // One read (the /refresh precedent): the user must still exist and be
                // active, and the pair is minted from their current roles/flags.
                val user = userService.read(userId)
                if (user == null) {
                    audit(EVENT_LOGIN_MFA_FAILURE, "reason" to "user_gone", "userId" to userId.toLong())
                    throw UnauthorizedException("Invalid or expired sign-in code")
                }
                if (outcome.credentialRevision != user.credentialRevision) {
                    audit(
                        EVENT_LOGIN_MFA_FAILURE,
                        "reason" to "credential_changed",
                        "userId" to userId.toLong(),
                    )
                    throw UnauthorizedException("Invalid or expired sign-in code")
                }
                audit("login.mfa_success", "email" to user.email, "userId" to userId.toLong())
                call.respond(
                    HttpStatusCode.OK,
                    jwtConfig.authResponse(userId, user),
                )
            }
        }
    }
}
