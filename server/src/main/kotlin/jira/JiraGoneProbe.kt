package ch.nokillswit.jira

import ch.nokillswit.infra.fetch.FetchException
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger("ch.nokillswit.sync")

/** The `gone_reason` of a probe that answered 404: Jira has no such issue for the connection's account (deleted, or not visible to it). */
internal const val GONE_DELETED = "DELETED"

/** The `gone_reason` of a probe that answered 403: the issue exists but the connection's account may not read it. */
internal const val GONE_FORBIDDEN = "FORBIDDEN"

/** The most bindings one run probes: the first of the newly flagged ones by binding id (the rest stay [GONE_OUT_OF_SCOPE]). */
internal const val GONE_PROBE_CAP = 100

/** The probe stops after this many failures in a row that say nothing about the issue (a site that is down or refusing): the rest stay. */
internal const val GONE_PROBE_MAX_FAILURES = 3

private const val NOT_FOUND = "NOT_FOUND"
private const val FORBIDDEN_SCOPE = "FORBIDDEN_SCOPE"

/** What a failed probe's transport code says about the issue: null for any code that says nothing (the row keeps the sweep's verdict). */
internal fun goneReasonFor(code: String): String? = when (code) {
    NOT_FOUND -> GONE_DELETED
    FORBIDDEN_SCOPE -> GONE_FORBIDDEN
    else -> null
}

/**
 * The probe step of a run: the sweep can only say a bound issue is absent from the in-scope listing ([GONE_OUT_OF_SCOPE]), so each
 * binding the sweep JUST flagged ([flagged], at most [GONE_PROBE_CAP], by binding id) is read once by id with `fields=id` through the
 * run's own guarded client: 404 -> [GONE_DELETED], 403 -> [GONE_FORBIDDEN], 200 -> nothing (readable, so moved out of the keys: it
 * stays `OUT_OF_SCOPE`), any other failure is logged and leaves `OUT_OF_SCOPE`. **A verdict is written as it arrives** (one short
 * transaction), so a run cut later (a stop from [beforeCall]: the connection deleted or disabled during the run, or a shutdown) keeps
 * every verdict already obtained; a failed or cut probe is not retried for that vanish. After [GONE_PROBE_MAX_FAILURES] failures in a
 * row (a 200 or a verdict resets the count) the probe stops, logs once and leaves the rest. A probe never fails the run: only
 * [FetchException] is caught here (never a cancellation), and a stop from [beforeCall] propagates. [onCall] counts each request sent.
 */
@Suppress("LongParameterList") // the run's seams (client, store, stop, tally), assembled once in execute()
internal suspend fun probeGone(
    runId: UInt,
    client: JiraClient,
    flagged: List<BoundIssue>,
    store: JiraRunStore,
    beforeCall: suspend () -> Unit,
    onCall: () -> Unit,
) {
    val queue = flagged.sortedBy { it.bindingId }.take(GONE_PROBE_CAP)
    var failuresInARow = 0
    for ((index, binding) in queue.withIndex()) {
        beforeCall()
        onCall()
        val answer = readById(client, binding)
        if (answer is ProbeAnswer.Said) {
            failuresInARow = 0
            if (answer.reason != null) store.setGoneReason(listOf(binding.bindingId), answer.reason)
            continue
        }
        log.warn("Sync run {} probe of issue {} failed: {}", runId, binding.issueId, (answer as ProbeAnswer.Failed).code)
        if (++failuresInARow >= GONE_PROBE_MAX_FAILURES) {
            log.warn(
                "Sync run {} probe stopped after {} failures in a row: {} binding(s) left unprobed",
                runId, GONE_PROBE_MAX_FAILURES, queue.size - index - 1,
            )
            return
        }
    }
}

/** One by-id read: [Said] when Jira answered about the issue (200: no [Said.reason]; 404 or 403: the verdict), else [Failed]. */
private sealed interface ProbeAnswer {
    data class Said(val reason: String?) : ProbeAnswer

    data class Failed(val code: String) : ProbeAnswer
}

private suspend fun readById(client: JiraClient, binding: BoundIssue): ProbeAnswer = try {
    client.issue(binding.issueId, "id")
    ProbeAnswer.Said(null)
} catch (failure: FetchException) {
    goneReasonFor(failure.code)?.let { ProbeAnswer.Said(it) } ?: ProbeAnswer.Failed(failure.code)
}
