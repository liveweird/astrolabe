package ch.nokillswit.jira

import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.time.MILLIS_PER_HOUR
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
 * holds them; three groups, ranked: **0** newly flagged in this run (`!gone` in the snapshot), **1** gone and never answered
 * (`probedAt == null`: a probe that failed, was cut or fell beyond the cap, or a row flagged before 1.10), **2** gone, stored
 * [GONE_OUT_OF_SCOPE] and answered (a readable 200: asked AGAIN, because the issue may have been deleted since) - every one on a [manual]
 * run (Refresh now), else only those whose answer is [censusHours] or more old at [now]. A stored [GONE_DELETED] or [GONE_FORBIDDEN]
 * is never asked again. Order: rank, then the oldest answer first, then binding id; the cap counts all three groups.
 */
internal fun goneProbeQueue(gone: List<BoundIssue>, manual: Boolean, now: Long, censusHours: Int, cap: Int): List<BoundIssue> {
    fun rank(binding: BoundIssue): Int? {
        val answeredAt = binding.probedAt
        return when {
            !binding.gone -> 0
            answeredAt == null -> 1
            binding.goneReason != GONE_OUT_OF_SCOPE -> null
            manual || now - answeredAt >= censusHours * MILLIS_PER_HOUR -> 2
            else -> null
        }
    }
    return gone.mapNotNull { binding -> rank(binding)?.let { it to binding } }
        .sortedWith(compareBy({ it.first }, { it.second.probedAt ?: 0L }, { it.second.bindingId }))
        .take(cap).map { it.second }
}

/**
 * The probe step of a run: the sweep can only say a bound issue is absent from the in-scope listing ([GONE_OUT_OF_SCOPE]), so each
 * binding in [goneProbeQueue] ([gone] = the ones the sweep judges gone; [manual], [censusHours] and [cap] as there) is read once by id
 * with `fields=id` through the run's own guarded client: 404 -> [GONE_DELETED], 403 -> [GONE_FORBIDDEN],
 * 200 -> stays `OUT_OF_SCOPE` (readable) and keeps the issue KEY the answer carried (`gone_probed_key`, validated by [probedKeyOf]; the
 * binding's key follows it), from which [wireGoneReason] reads moved out or not listed. **Every answer stamps `gone_probed_at`**
 * ([now]; the 200 too, a re-asked one restamps and refreshes the key), and
 * is written as it arrives (one short transaction), so a run cut later (a stop from [beforeCall]: the connection deleted or disabled
 * during the run, or a shutdown) keeps every answer already obtained; a failed, cut or over-cap probe writes nothing (a never-answered
 * row stays unstamped, a re-asked one keeps its former answer), so a later run probes it again (while the sweep still judges the binding
 * gone). After [GONE_PROBE_MAX_FAILURES] failures in a row (a 200 or a verdict resets the count) the probe stops, logs once and leaves
 * the rest. A probe never fails the run: only [FetchException] is caught here (never a cancellation), and a stop from [beforeCall]
 * propagates. [onCall] counts each request sent.
 */
@Suppress("LongParameterList") // the run's seams (client, store, clock, cap, trigger, interval, stop, tally), assembled once in execute()
internal suspend fun probeGone(
    runId: UInt,
    client: JiraClient,
    gone: List<BoundIssue>,
    store: JiraRunStore,
    now: () -> Long,
    cap: Int,
    manual: Boolean,
    censusHours: Int,
    beforeCall: suspend () -> Unit,
    onCall: () -> Unit,
) {
    val queue = goneProbeQueue(gone, manual, now(), censusHours, cap)
    var failuresInARow = 0
    for ((index, binding) in queue.withIndex()) {
        beforeCall()
        onCall()
        val answer = readById(client, binding)
        if (answer is ProbeAnswer.Said) {
            failuresInARow = 0
            store.recordProbe(binding.bindingId, answer.reason, answer.key, now())
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
