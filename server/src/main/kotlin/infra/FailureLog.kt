package ch.nokillswit.infra

import java.util.concurrent.ConcurrentHashMap
import org.slf4j.Logger

private const val MAX_FAILURE_TEXT = 300

/**
 * One failure line per named unit of a background loop, not one per tick: the first failure is a WARN (the exception's `toString`, never a
 * stack), further failures DEBUG, and the first success after a failure an INFO "recovered". Shared by the telemetry sampler (its
 * collectors) and the sync scheduler (its connectors and connections); [subject] is the log text's noun ("Telemetry collector").
 *
 * The text is [describe] of the exception (default `toString`) cut to 300 characters. A caller whose exceptions can carry a stored value or
 * a secret in their message (a database error quotes its statement) passes a [describe] that names the CLASS only.
 */
internal class FailureLog(
    private val log: Logger,
    private val subject: String,
    private val describe: (Throwable) -> String = Throwable::toString,
) {
    private val failing = ConcurrentHashMap.newKeySet<String>()

    fun failed(name: String, e: Throwable) {
        val text = describe(e).take(MAX_FAILURE_TEXT)
        if (failing.add(name)) {
            log.warn("{} {} failed: {}", subject, name, text)
        } else {
            log.debug("{} {} failed again: {}", subject, name, text)
        }
    }

    /**
     * Silently drops the failure state of every unit whose name starts with [prefix] and is not in [keep] (a unit that left the loop's
     * view: deleted, disabled): a later failure of the same name is a first failure again and warns, and nothing claims it "recovered".
     */
    fun forgetExcept(prefix: String, keep: Set<String>) {
        failing.removeIf { it.startsWith(prefix) && it !in keep }
    }

    fun ok(name: String) {
        if (failing.remove(name)) log.info("{} {} recovered", subject, name)
    }
}
