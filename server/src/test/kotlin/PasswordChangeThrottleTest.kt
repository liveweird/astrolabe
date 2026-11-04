package ch.nokillswit

import ch.nokillswit.auth.LoginThrottle
import ch.nokillswit.authz.ForbiddenException
import ch.nokillswit.authz.TooManyRequestsException
import ch.nokillswit.users.PasswordChangeThrottle
import kotlin.test.Test
import kotlin.test.assertFailsWith

/**
 * The route-facing wrapper over an injected [LoginThrottle] (no database): the branches a route test cannot reach
 * deterministically because they are races between the preflight and the recorded outcome.
 */
class PasswordChangeThrottleTest {
    private val user = 7u

    private fun throttle(maxTracked: Int = 10, threshold: Int = 2) =
        PasswordChangeThrottle(LoginThrottle(threshold = threshold, lockoutMillis = 900_000, maxTracked = maxTracked, clock = { 1_000L }))

    private fun PasswordChangeThrottle.lock(id: UInt = user) {
        repeat(2) { assertFailsWith<ForbiddenException> { denyWrongCurrent(id) } }
    }

    @Test
    fun `a failure recorded after another request locked the account is a 429, not a 403`() {
        val t = throttle()
        t.lock()
        // The request had passed the preflight before the lock tripped: its failure meets ALREADY_LOCKED.
        assertFailsWith<TooManyRequestsException> { t.denyWrongCurrent(user) }
    }

    @Test
    fun `a success that meets a lock tripped meanwhile is a 429 and does not clear it`() {
        val t = throttle()
        t.lock()
        assertFailsWith<TooManyRequestsException> { t.recordSuccess(user) }
        assertFailsWith<TooManyRequestsException> { t.requireNotLocked(user) }
    }

    @Test
    fun `a failure for an untracked user at capacity is a 429`() {
        val t = throttle(maxTracked = 1)
        assertFailsWith<ForbiddenException> { t.denyWrongCurrent(1u) }
        assertFailsWith<TooManyRequestsException> { t.denyWrongCurrent(2u) }
        assertFailsWith<TooManyRequestsException> { t.requireNotLocked(2u) }
    }

    @Test
    fun `a success below the threshold clears and an explicit clear lifts an active lock`() {
        val t = throttle()
        assertFailsWith<ForbiddenException> { t.denyWrongCurrent(user) }
        t.recordSuccess(user)
        assertFailsWith<ForbiddenException> { t.denyWrongCurrent(user) } // the counter restarted: one, not two
        t.requireNotLocked(user)

        t.lock(8u)
        assertFailsWith<TooManyRequestsException> { t.requireNotLocked(8u) }
        t.clear(8u)
        t.requireNotLocked(8u)
    }
}
