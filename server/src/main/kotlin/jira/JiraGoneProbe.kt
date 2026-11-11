package ch.nokillswit.jira

import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.time.MILLIS_PER_HOUR
import ch.nokillswit.sync.ClaimedRun
import ch.nokillswit.sync.SyncTrigger
import kotlinx.serialization.json.JsonObject
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger("ch.nokillswit.sync")

/** The `gone_reason` of a probe that answered 404: Jira has no such issue for the connection's account (deleted, or not visible to it). */
internal const val GONE_DELETED = "DELETED"

/** The `gone_reason` of a probe that answered 403: the issue exists but the connection's account may not read it. */
internal const val GONE_FORBIDDEN = "FORBIDDEN"

/** The most bindings one run probes, over the three groups of [goneProbeQueue] (the rest wait for a later run). */
internal const val GONE_PROBE_CAP = 100

/** The probe stops after this many failures in a row that say nothing about the issue (a site that is down or refusing): the rest stay. */
internal const val GONE_PROBE_MAX_FAILURES = 3

/**
 * The wire `goneReason` of a probe that answered 200 under a key OUTSIDE the connection's projects (1.12; since 1.13 checked against the
 * key the answer carried): derived on read, never stored (the column keeps `OUT_OF_SCOPE`). Also what a 200 that kept no key reads (1.12's
 * inference: "Jira still has it, readable by id, absent from the connection's listing").
 */
internal const val GONE_MOVED_OUT = "MOVED_OUT"

/**
 * The wire `goneReason` of a probe that answered 200 under a key INSIDE the connection's projects (1.13): Jira has the issue where the
 * connection looks, yet the listing no longer returns it (archived, a type change, a false-empty sweep). Derived on read, like
 * [GONE_MOVED_OUT].
 */
internal const val GONE_NOT_LISTED = "NOT_LISTED"

private const val NOT_FOUND = "NOT_FOUND"
private const val FORBIDDEN_SCOPE = "FORBIDDEN_SCOPE"

/** What a failed probe's transport code says about the issue: null for any code that says nothing (the row keeps the sweep's verdict). */
internal fun goneReasonFor(code: String): String? = when (code) {
    NOT_FOUND -> GONE_DELETED
    FORBIDDEN_SCOPE -> GONE_FORBIDDEN
    else -> null
}

/**
 * The wire form of a stored `gone_reason`, derived on read against the connection's CURRENT [projectKeys] (a key edit needs no rewrite).
 * Only `OUT_OF_SCOPE` with a probe's answer ([probedAt] set: the 200) is refined: no [probedKey] (answered before 1.13, or the document's
 * key was unusable) reads [GONE_MOVED_OUT] (1.12's inference), a key inside the projects [GONE_NOT_LISTED], one outside [GONE_MOVED_OUT].
 * Anything else (not gone, a 404 or 403 verdict, a row not yet answered for) is returned as stored.
 */
internal fun wireGoneReason(stored: String?, probedAt: Long?, probedKey: String?, projectKeys: Collection<String>): String? = when {
    stored != GONE_OUT_OF_SCOPE || probedAt == null -> stored
    probedKey == null -> GONE_MOVED_OUT
    isInScope(probedKey, projectKeys) -> GONE_NOT_LISTED
    else -> GONE_MOVED_OUT
}

/**
 * The bindings one run probes, in order, at most [cap] (1.13). [gone] are the bindings the sweep judges gone, as the run-start snapshot
 * holds them; three ranks: **0** newly flagged in this run (`!gone` in the snapshot), **1** gone and never answered
 * (`probedAt == null`: a probe that failed, was cut or fell beyond the cap, or a row flagged before 1.10), **2** gone, stored
 * [GONE_OUT_OF_SCOPE] and answered (a readable 200: asked AGAIN, because the issue may have been deleted since) - every one on a [manual]
 * run (Refresh now), else only those whose answer is [censusHours] or more old at [now]. A stored [GONE_DELETED] or [GONE_FORBIDDEN]
 * is never asked again. [retries] = false (a tripped [GoneProbeDamper] on a scheduled run) leaves ranks 1 and 2 out. Order, in four
 * groups: rank 0; rank-1 rows never tried; rank-2 rows never tried; then every rank-1 and rank-2 row whose read FAILED before ([lastTried],
 * the damper's memory), the least recently tried first. Inside a group: the time of the last failed read, else the answer's, else never
 * (oldest first), then binding id. So bindings whose read keeps failing queue behind every one not yet tried - rank 2 included, so
 * stuck rank-1 rows cannot fill the breaker ahead of the daily re-ask on every run; the cap counts all three ranks.
 */
internal fun goneProbeQueue(
    gone: List<BoundIssue>,
    manual: Boolean,
    now: Long,
    censusHours: Int,
    cap: Int,
    lastTried: Map<UInt, Long> = emptyMap(),
    retries: Boolean = true,
): List<BoundIssue> {
    fun rank(binding: BoundIssue): Int? {
        val answeredAt = binding.probedAt
        return when {
            !binding.gone -> 0
            !retries -> null
            answeredAt == null -> 1
            binding.goneReason != GONE_OUT_OF_SCOPE -> null
            manual || now - answeredAt >= censusHours * MILLIS_PER_HOUR -> 2
            else -> null
        }
    }
    fun group(rank: Int, binding: BoundIssue): Int = if (rank == 0 || binding.bindingId !in lastTried) rank else 3
    return gone.mapNotNull { binding -> rank(binding)?.let { group(it, binding) to binding } }
        .sortedWith(compareBy({ it.first }, { lastTried[it.second.bindingId] ?: it.second.probedAt ?: 0L }, { it.second.bindingId }))
        .take(cap).map { it.second }
}

/** What the probe step of one run did: reads [sent], [answered] among them, and the [lastFailure] code (null when none failed). */
private class ProbeTally(var sent: Int = 0, var answered: Int = 0, var lastFailure: String? = null)

/**
 * The probe step of a run: the sweep can only say a bound issue is absent from the in-scope listing ([GONE_OUT_OF_SCOPE]), so each
 * binding in [goneProbeQueue] ([gone] = the ones the sweep judges gone; a MANUAL [run] is a Refresh now; [censusHours] and [cap] as
 * there) is read once by id with `fields=id` through the run's own guarded client: 404 -> [GONE_DELETED], 403 -> [GONE_FORBIDDEN],
 * 200 -> stays `OUT_OF_SCOPE` (readable) and keeps the issue KEY the answer carried (`gone_probed_key`, validated by [probedKeyOf]; the
 * binding's key follows it), from which [wireGoneReason] reads moved out or not listed. **Every answer stamps `gone_probed_at`**
 * ([now]; the 200 too, a re-asked one restamps and refreshes the key), and
 * is written as it arrives (one short transaction), so a run cut later (a stop from [beforeCall]: the connection deleted or disabled
 * during the run, or a shutdown) keeps every answer already obtained; a failed, cut or over-cap probe writes nothing (a never-answered
 * row stays unstamped, a re-asked one keeps its former answer), so a later run probes it again (while the sweep still judges the binding
 * gone). After [GONE_PROBE_MAX_FAILURES] failures in a row (a 200 or a verdict resets the count) the probe stops, logs and leaves
 * the rest. A probe never fails the run: only [FetchException] is caught here (never a cancellation), and a stop from [beforeCall]
 * propagates (and counts for nothing in the [damper]). [onCall] counts each request sent.
 *
 * The [damper] backs a connection off once the probe got no answer at all in [GONE_PROBE_FAILING_RUNS] scheduled runs in a row (retries
 * only on Refresh now, or once per [censusHours]; a newly flagged binding is always asked) and sets the log levels. A per-issue failure
 * line is WARN only when the run is the streak's first failing one (no failing run counted when it began), the binding is newly flagged
 * (rank 0) or the run is MANUAL, else DEBUG; the breaker line is WARN in the streak's first failing run, DEBUG after; one WARN when the
 * streak trips; one INFO when an answer ends a tripped streak. Ids, counts and the transport code only, never a key.
 */
internal suspend fun probeGone(
    run: ClaimedRun,
    client: JiraClient,
    gone: List<BoundIssue>,
    store: JiraRunStore,
    damper: GoneProbeDamper,
    now: () -> Long,
    cap: Int,
    censusHours: Int,
    beforeCall: suspend () -> Unit,
    onCall: () -> Unit,
) {
    val connectionId = run.connectionId
    val manual = run.trigger == SyncTrigger.MANUAL
    damper.retain(connectionId, gone.mapTo(HashSet()) { it.bindingId })
    val retries = damper.retriesAllowed(connectionId, manual, now(), censusHours * MILLIS_PER_HOUR)
    val queue = goneProbeQueue(gone, manual, now(), censusHours, cap, damper.lastTried(connectionId), retries)
    val firstFailingRun = damper.firstFailingRun(connectionId)
    val tally = ProbeTally()
    var failuresInARow = 0
    for ((index, binding) in queue.withIndex()) {
        beforeCall()
        onCall()
        tally.sent++
        val answer = readById(client, binding)
        if (answer is ProbeAnswer.Said) {
            failuresInARow = 0
            tally.answered++
            store.recordProbe(binding.bindingId, answer.reason, answer.key, now())
            damper.answered(connectionId, binding.bindingId)
            continue
        }
        val code = (answer as ProbeAnswer.Failed).code
        tally.lastFailure = code
        damper.failed(connectionId, binding.bindingId, now())
        if (firstFailingRun || manual || !binding.gone) {
            log.warn("Sync run {} probe of issue {} failed: {}", run.id, binding.issueId, code)
        } else {
            log.debug("Sync run {} probe of issue {} failed: {}", run.id, binding.issueId, code)
        }
        if (++failuresInARow >= GONE_PROBE_MAX_FAILURES) {
            val left = queue.size - index - 1
            val message = "Sync run {} probe stopped after {} failures in a row: {} binding(s) left unprobed"
            if (firstFailingRun) {
                log.warn(message, run.id, GONE_PROBE_MAX_FAILURES, left)
            } else {
                log.debug(message, run.id, GONE_PROBE_MAX_FAILURES, left)
            }
            break
        }
    }
    when (damper.endRun(connectionId, tally.sent, tally.answered, retries, manual, now())) {
        StreakChange.TRIPPED -> log.warn(
            "Sync run {} (connection {}) gone probe got no answer in {} runs in a row ({}): retried once every {} h and on Refresh now",
            run.id, connectionId, GONE_PROBE_FAILING_RUNS, tally.lastFailure, censusHours,
        )
        StreakChange.RECOVERED -> log.info("Sync run {} (connection {}) gone probe answers again", run.id, connectionId)
        StreakChange.NONE -> Unit
    }
}

/**
 * One by-id read: [Said] when Jira answered about the issue (200: no [Said.reason], and the validated current [Said.key] or null; 404 or
 * 403: the verdict, no key), else [Failed].
 */
private sealed interface ProbeAnswer {
    data class Said(val reason: String?, val key: String? = null) : ProbeAnswer

    data class Failed(val code: String) : ProbeAnswer
}

private suspend fun readById(client: JiraClient, binding: BoundIssue): ProbeAnswer = try {
    ProbeAnswer.Said(null, probedKeyOf(client.issue(binding.issueId, "id"), binding.issueId))
} catch (failure: FetchException) {
    goneReasonFor(failure.code)?.let { ProbeAnswer.Said(it) } ?: ProbeAnswer.Failed(failure.code)
}

/**
 * The key a 200 carries, kept only when the document is the probed issue (its `id` equals [issueId]) and the key has the issue-key shape:
 * the value comes from an outbound response and is stored, then rendered as a link, so anything else reads as no key (the 200 still counts
 * as an answer).
 */
private fun probedKeyOf(document: JsonObject, issueId: String): String? =
    document["id"].text(MAX_ID)?.takeIf { it == issueId }?.let { document["key"].text(MAX_ID)?.takeIf(ISSUE_KEY_PATTERN::matches) }
