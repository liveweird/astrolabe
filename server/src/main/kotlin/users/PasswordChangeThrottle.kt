package ch.nokillswit.users

import ch.nokillswit.audit.audit
import ch.nokillswit.auth.LoginThrottle
import ch.nokillswit.auth.MAX_DURATION_SECONDS
import ch.nokillswit.auth.MAX_TRACKED_IDENTITIES
import ch.nokillswit.authz.ForbiddenException
import ch.nokillswit.authz.TooManyRequestsException
import ch.nokillswit.infra.config.requireConfigInt
import ch.nokillswit.infra.config.requireConfigLong
import ch.nokillswit.plugins.RateLimitAuditThrottle
import io.ktor.server.application.Application
import io.ktor.util.AttributeKey

/**
 * Per-user throttle on the SELF password change's current-password check (`PUT /users/{id}/password` for the caller's own id).
 * A stolen session could otherwise grind the owner's current password at bcrypt speed, bounded only by the per-user token
 * lifetime. It is a SEPARATE [LoginThrottle] instance from `/login`'s, keyed by user id and sized by the same
 * `security.lockout.*` settings, so a thief holding a session can lock only THIS endpoint and never the owner's sign-in.
 * Locked attempts answer 429 (thrown: StatusPages' generic 429 handler would rewrite a direct `respondProblem`), never 403.
 * The admin path (resetting another user's password) never reaches it. In-memory and per-instance, like the login lockout.
 */
internal class PasswordChangeThrottle(
    private val throttle: LoginThrottle,
    private val lockedAudit: RateLimitAuditThrottle = RateLimitAuditThrottle(),
) {
    private fun key(userId: UInt) = "user:$userId"

    /** Before the body decodes and before any bcrypt work: a locked (or untrackable) account answers 429. */
    fun requireNotLocked(userId: UInt) {
        when (throttle.preflight(key(userId))) {
            LoginThrottle.Preflight.ALLOWED -> Unit
            LoginThrottle.Preflight.LOCKED -> rejectLocked(userId)
            LoginThrottle.Preflight.CAPACITY_EXCEEDED -> rejectCapacity(userId)
        }
    }

    /** A wrong or missing current password: counts the failure, audits it and always throws (403, or 429 once locked). */
    fun denyWrongCurrent(userId: UInt): Nothing {
        when (throttle.recordFailure(key(userId))) {
            LoginThrottle.FailureResult.CAPACITY_EXCEEDED -> rejectCapacity(userId)
            LoginThrottle.FailureResult.ALREADY_LOCKED -> rejectLocked(userId)
            LoginThrottle.FailureResult.RECORDED -> auditDenied(userId)
            LoginThrottle.FailureResult.LOCKED_NOW -> {
                auditDenied(userId)
                audit("password.change_locked", "targetUserId" to userId.toLong())
            }
        }
        throw ForbiddenException("Current password is missing or incorrect")
    }

    /** A correct current password clears the counter; a lock tripped by a concurrent request still wins (429). */
    fun recordSuccess(userId: UInt) {
        if (throttle.recordSuccess(key(userId)) == LoginThrottle.SuccessResult.LOCKED) rejectLocked(userId)
    }

    /** A password reset (an admin's, or the emailed link) ends every session, so it also ends the lock, even an active one. */
    fun clear(userId: UInt) = throttle.clear(key(userId))

    private fun auditDenied(userId: UInt) = audit(
        "password.change_denied",
        "targetUserId" to userId.toLong(),
        "byUserId" to userId.toLong(),
        "reason" to "wrong_current_password",
    )

    private fun rejectLocked(userId: UInt): Nothing {
        // Coalesced: a client hammering a locked account must not write a line per request (the lock itself already
        // bounds password.change_denied at the threshold per window).
        lockedAudit.admit("password-change:$userId")?.let { suppressed ->
            audit("password.change_rejected_locked", "targetUserId" to userId.toLong(), "suppressed" to suppressed)
        }
        throw TooManyRequestsException("Too many wrong current passwords — try again later", PASSWORD_CHANGE_LOCKED_TYPE)
    }

    private fun rejectCapacity(userId: UInt): Nothing {
        audit("password.change_capacity_rejected", "targetUserId" to userId.toLong())
        throw TooManyRequestsException("Too many password changes are being tracked — try again later")
    }
}

/** Published by [configureUserRoutes]; read at request time so a test can swap it (injected clock). */
/**
 * The problem `type` of the lock's 429 (`urn:astrolabe:problem:password-change-locked`): the SPA tells it from a rate-bucket 429
 * (`about:blank`, with `Retry-After`) on this, never on the prose. The capacity 429 keeps `about:blank`: it is not the owner's lock.
 */
internal const val PASSWORD_CHANGE_LOCKED_TYPE = "urn:astrolabe:problem:password-change-locked"

internal val PasswordChangeThrottleKey = AttributeKey<PasswordChangeThrottle>("PasswordChangeThrottle")

/** Built from the same `security.lockout.*` settings as the login lockout (bounds shared with `auth/AuthRoutes.kt`). */
internal fun Application.passwordChangeThrottle(): PasswordChangeThrottle = PasswordChangeThrottle(
    LoginThrottle(
        threshold = requireConfigInt(environment.config, "security.lockout.threshold", min = 1),
        lockoutMillis = requireConfigLong(
            environment.config, "security.lockout.durationSeconds", min = 1, max = MAX_DURATION_SECONDS,
        ) * 1000,
        maxTracked = requireConfigInt(environment.config, "security.lockout.maxTracked", min = 1, max = MAX_TRACKED_IDENTITIES),
    ),
)
