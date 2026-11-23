package ch.nokillswit

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The one bounded poll for "the thing under test has reached state X" barriers: it ends the moment [condition] holds (no fixed pause,
 * so no timing guess) and fails with [what] after [timeoutMillis]. Prefer a real signal (`CompletableDeferred`, `awaitLockWait`)
 * where the code under test offers a seam; poll only an external observable such as a stub's request journal.
 */
suspend fun awaitUntil(what: String, timeoutMillis: Long = AWAIT_BUDGET_MILLIS, condition: () -> Boolean) {
    val reached = withTimeoutOrNull(timeoutMillis) {
        while (!condition()) delay(AWAIT_POLL_MILLIS)
        true
    }
    check(reached == true) { "timed out after $timeoutMillis ms waiting for $what" }
}

private const val AWAIT_BUDGET_MILLIS = 10_000L
private const val AWAIT_POLL_MILLIS = 10L
