package ch.nokillswit.jira

import ch.nokillswit.audit.audit
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.fetch.BACKOFF_MS_KEY
import ch.nokillswit.infra.fetch.CallTally
import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.fetch.LIMIT_EXCEEDED_CODE
import ch.nokillswit.infra.fetch.PageCeiling
import ch.nokillswit.infra.fetch.PageTokenGuard
import ch.nokillswit.infra.fetch.RATE_LIMITED_KEY
import ch.nokillswit.infra.fetch.TENANT_PAUSED_MS_KEY
import ch.nokillswit.sync.ClaimedRun
import ch.nokillswit.sync.Connector
import ch.nokillswit.sync.SyncCounts
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncResult
import ch.nokillswit.sync.SyncRunService
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.slf4j.LoggerFactory

val JiraObserverKey = AttributeKey<JiraObserver>("JiraObserver")

private val log = LoggerFactory.getLogger("ch.nokillswit.sync")

private const val SEARCH_ENDPOINT = "/rest/api/3/search/jql"

/**
 * The search pages ONE read may follow (200 x `jira.pageSize` issues); more is `LIMIT_EXCEEDED`, never a silent truncation. It is per
 * read, not per run: the read and the sweep each get their own 200.
 */
private const val MAX_SEARCH_PAGES = 200
private const val CURSOR_EXPIRED = "CURSOR_EXPIRED"
private const val MILLIS_PER_MINUTE = 60_000L

/** Typed run failures the connector reports as `FAILED` + [code]; none involves a call to Jira. */
private class RunProblem(val code: String, val detail: String) : RuntimeException(detail)

/**
 * The run's mutable tally of its own work (the registry's counters); the Jira throttling figures come from the [CallTally]. Every change
 * calls [onChange], which publishes the counters to the run's meter, so a run cut from outside keeps what it had spent.
 */
private class RunProgress {
    var onChange: () -> Unit = {}

    /** Run before every search page: ends the run (`RunProblem`) once its connection is deleted or disabled. */
    var beforePage: suspend () -> Unit = {}
    var calls = 0
        set(value) {
            field = value
            onChange()
        }
    var observed = 0
        set(value) {
            field = value
            onChange()
        }
    var gone = 0
        set(value) {
            field = value
            onChange()
        }
}

/** How a run reads the bound issues: everything of the mapped types, or what changed since the last succeeded run started. */
private sealed interface ReadPlan {
    data object Full : ReadPlan

    data class Incremental(val lastStart: Long) : ReadPlan
}

/**
 * The Jira connector's run (§3.6 "One run"): the node sweep, an incremental (or, with no usable watermark, full) read of the bound issues
 * into observations, then a sweep of the ids still in scope that flags the vanished ones `gone`. It OBSERVES: nothing is ever written to
 * Jira, no plan lock is taken, no plan revision moves. Every database write is a short transaction of at most [RUN_CHUNK] bindings
 * ([JiraRunStore]); no transaction is open across a Jira call; a failure part-way leaves whole chunks written and nothing half-written.
 *
 * Every problem of the run itself is a typed [SyncResult.failed]: a [FetchException] keeps its code, an undecryptable token is
 * `TOKEN_UNREADABLE`, a mapping that no longer fits the site `MAPPING_INVALID` (the stored mapping is never rewritten), and so on.
 */
class JiraObserver internal constructor(
    private val connector: JiraConnector,
    private val connections: JiraConnectionService,
    private val store: JiraRunStore,
    private val runs: SyncRunService,
    private val now: () -> Long = ::nowMillis,
    /** The bindings one write transaction carries ([RUN_CHUNK]); a test shrinks it to see whole chunks. */
    private val chunkSize: Int = RUN_CHUNK,
) : Connector {
    override val kind = SyncKind.JIRA

    override suspend fun requireRunnable(connectionId: UInt) {
        if (!connections.isRunnable(connectionId)) throw BadRequestException(UNKNOWN_CONNECTION)
    }

    override suspend fun run(run: ClaimedRun): SyncResult {
        val tally = CallTally()
        val progress = RunProgress()

        fun counts(): SyncCounts {
            val throttle = tally.snapshot()
            return SyncCounts(
                observed = progress.observed,
                gone = progress.gone,
                calls = progress.calls,
                rateLimited = (throttle[RATE_LIMITED_KEY] ?: 0L).toInt(),
                backoffMs = (throttle[BACKOFF_MS_KEY] ?: 0L) + (throttle[TENANT_PAUSED_MS_KEY] ?: 0L),
            )
        }
        progress.onChange = { run.meter.counts = counts() }
        return withContext(tally) {
            try {
                execute(run, progress)
                SyncResult.succeeded(counts())
            } catch (problem: RunProblem) {
                SyncResult.failed(problem.code, problem.detail, counts())
            } catch (failure: FetchException) {
                SyncResult.failed(failure.code, failure.message, counts())
            }
        }
    }

    private suspend fun execute(run: ClaimedRun, progress: RunProgress) {
        val context = connections.readForBind(run.connectionId)
            ?: throw RunProblem("CONNECTION_GONE", "The Jira connection no longer exists")
        if (!context.enabled) throw RunProblem("CONNECTION_DISABLED", "The Jira connection is disabled")
        releaseDeadNodeBindings(run)
        val token = context.target.apiToken ?: throw RunProblem(
            JiraConnector.TOKEN_UNREADABLE_CODE, "The stored API token cannot be decrypted - ask an administrator to enter it again",
        )
        val discovery = context.state.discovery ?: throw RunProblem("NOT_DISCOVERED", "The connection has not been tested yet")
        val mapping = when (val resolved = resolveEffectiveMapping(context.state, discovery)) {
            is MappingResolution.Usable -> resolved.mapping
            MappingResolution.Unreadable -> throw RunProblem("MAPPING_UNREADABLE", "The stored mapping cannot be read by this version")
            is MappingResolution.Invalid -> throw RunProblem("MAPPING_INVALID", resolved.problem)
        }
        val sweepTypes = sweepTypeIds(mapping, discovery)
            ?: throw RunProblem("MAPPING_INVALID", "A mapped level has no issue type in the discovery snapshot")
        val bound = store.snapshot(run.connectionId)
        if (bound.isEmpty()) return
        progress.beforePage = {
            when (connections.runnableState(run.connectionId)) {
                RunnableState.RUNNABLE -> Unit
                RunnableState.GONE -> throw RunProblem("CONNECTION_GONE", "The Jira connection was deleted during the run")
                RunnableState.DISABLED -> throw RunProblem("CONNECTION_DISABLED", "The Jira connection was disabled during the run")
            }
        }

        val keys = context.target.projectKeys
        val client = connector.clientFor(context.target, token)
        progress.calls++
        connections.storeCloudId(run.connectionId, client.resolveCloudId())

        val byIssue = bound.associateBy { it.issueId }
        val plan = readPlan(run, bound, discovery, changedAt(context))
        val fields = observationFields(mapping)
        suspend fun readAs(shape: ReadPlan) =
            read(client, readJql(shape, keys, sweepTypes), fields, mapping, discovery, byIssue, progress)
        val observed = try {
            readAs(plan)
        } catch (failure: FetchException) {
            // A long gap on a busy site: the incremental window only grows, so a ceiling hit would wedge every later run. The full read
            // is limited to the mapped types and is bounded by the site, not by the gap.
            if (plan is ReadPlan.Incremental && failure.code == LIMIT_EXCEEDED_CODE) readAs(ReadPlan.Full) else throw failure
        }
        val inScope = HashSet<String>()
        search(client, { JiraJql.sweep(keys, sweepTypes) }, "id", progress) { issues ->
            issues.forEach { entry -> idOf(entry)?.let(inScope::add) }
        }
        reconcile(run, bound, sweepTypes.toSet(), inScope, observed, progress)
    }

    /**
     * The full read when no earlier run succeeded, a binding has no observation to build on, or anything that decides WHAT an unchanged
     * issue reads as changed since the last run started: the site was re-discovered (new fields and levels), the mapping was changed
     * (`mapping_changed_at`, set only by a PUT that altered the document), or the connection was edited (`updated_at`: a widened
     * `projectKeys` brings back issues that were not read while out of scope, a new token or account may see other fields). Otherwise the
     * watermark's incremental. The effective mapping falls back to the discovery's defaults, so a re-discovery already covers that case.
     */
    private suspend fun readPlan(run: ClaimedRun, bound: List<BoundIssue>, discovery: JiraDiscovery, changedAt: Long): ReadPlan {
        val lastStart = runs.lastSucceededStart(SyncKind.JIRA, run.connectionId)
        val trustable = lastStart != null && bound.all { it.observed } && maxOf(discovery.discoveredAt, changedAt) <= lastStart
        return if (lastStart != null && trustable) ReadPlan.Incremental(lastStart) else ReadPlan.Full
    }

    /**
     * The read's JQL as a function of the CLOCK: the incremental's relative bound is `updated >= "-Nm"`, which Jira measures from the
     * moment it answers, so N is worked out afresh from [now] at every first-page request - a restart after an expired cursor included -
     * and the window is never shorter than the time since the last succeeded run's start plus the overlap. The FULL read is limited to
     * the mapped levels' types (the sweep's clause); the incremental is not, because an unfiltered window is how a change of type is seen.
     */
    private fun readJql(plan: ReadPlan, keys: List<String>, types: List<String>): () -> String = when (plan) {
        ReadPlan.Full -> { { JiraJql.full(keys, types) } }
        is ReadPlan.Incremental -> {
            {
                val sinceMinutes = (now() - plan.lastStart + MILLIS_PER_MINUTE - 1).coerceAtLeast(0) / MILLIS_PER_MINUTE
                JiraJql.incremental(keys, sinceMinutes + connector.incrementalOverlapMinutes)
            }
        }
    }

    /**
     * Observes every BOUND issue [jql] returns, each at the level of its BINDING (a mismatch with the issue's own type stays a deviation
     * to show) and writes them in chunks. Answers the issue ids written.
     */
    @Suppress("LongParameterList") // the read's inputs, assembled once in execute()
    private suspend fun read(
        client: JiraClient,
        jql: () -> String,
        fields: String,
        mapping: JiraMapping,
        discovery: JiraDiscovery,
        byIssue: Map<String, BoundIssue>,
        progress: RunProgress,
    ): Set<String> {
        val written = LinkedHashSet<String>()
        val pending = ArrayList<Pair<UInt, JiraObservation>>()
        suspend fun flush() {
            if (pending.isEmpty()) return
            val writtenIds = store.writeObservations(pending.toList()).toSet()
            pending.clear()
            byIssue.values.filter { it.bindingId in writtenIds }.forEach { written += it.issueId }
            progress.observed = written.size
        }
        search(client, jql, fields, progress) { issues ->
            for (entry in issues) {
                val issue = entry as? JsonObject ?: continue
                val bound = idOf(issue)?.let(byIssue::get) ?: continue
                val observation = JiraObservation.of(issue, mapping, discovery, bound.level, now()) ?: continue
                pending += bound.bindingId to observation
                if (pending.size >= chunkSize) flush()
            }
        }
        flush()
        return written
    }

    /**
     * After BOTH reads: a bound id missing from the in-scope listing is `gone` unless this run just read it (it plainly exists) or the
     * sweep CANNOT JUDGE it. The sweep asks only for the mapped types, so an issue whose last observed type is not among [sweepTypes] -
     * or is unknown (no observation yet, a type created after the last Test connection, one beyond the snapshot's cap) - is invisible to it
     * whether or not it exists: it is never flagged here (its stored level keeps showing as a `LEVEL_MISMATCH`). A flagged binding the
     * sweep sees again, and this run did not re-read, has its flag cleared with its content untouched (an incremental read does not
     * return an unchanged issue). A genuinely empty listing of a non-empty bound set still flags: a false flag warns only and heals on
     * the next good sweep, while failing the run would wedge a site whose only bound item really was deleted - so it is logged.
     */
    private suspend fun reconcile(
        run: ClaimedRun,
        bound: List<BoundIssue>,
        sweepTypes: Set<String>,
        inScope: Set<String>,
        observed: Set<String>,
        progress: RunProgress,
    ) {
        val gone = bound.filter { it.issueId !in inScope && it.issueId !in observed && it.typeId in sweepTypes }
        val back = bound.filter { it.gone && it.issueId in inScope && it.issueId !in observed }
        if (inScope.isEmpty() && bound.isNotEmpty()) {
            log.warn("Sync run {} sweep listed no issue at all for {} bound issue(s): {} flagged gone", run.id, bound.size, gone.size)
        }
        gone.map { it.bindingId }.chunked(chunkSize).forEach { store.markGone(it) }
        back.map { it.bindingId }.chunked(chunkSize).forEach { store.clearGone(it) }
        progress.gone = gone.size
    }

    private suspend fun releaseDeadNodeBindings(run: ClaimedRun) {
        val released = store.releaseDeadNodeBindings(run.connectionId)
        released.forEach {
            audit(
                "jira.binding_released",
                "byUserId" to run.byUserId?.toLong(),
                "bindingId" to it.bindingId.toLong(),
                "connectionId" to it.connectionId.toLong(),
                "level" to it.level.name,
                "nodeId" to it.nodeId.toLong(),
                "issueKey" to it.issueKey,
                "reason" to "NODE_GONE",
                "runId" to run.id.toLong(),
            )
        }
        if (released.isNotEmpty()) log.info("Sync run {} released {} binding(s) of deleted plan nodes", run.id, released.size)
    }

    /**
     * Pages through `search/jql` for [jql]/[fields] and hands each page's issues to [onPage]. Bounded by [MAX_SEARCH_PAGES] and a guard
     * against a cycling `nextPageToken`. [jql] is asked for at every FIRST-page request, so a restart after an expired cursor starts from
     * the first page of a query rebuilt at that moment (the relative bound moves with the clock); a second expiry fails the run
     * `CURSOR_EXPIRED`. The restart re-delivers pages, which every caller tolerates (an upsert, a set). A `200` that is not a listing - no
     * `issues` member, or `isLast: false` with no token to continue from - is `INVALID_RESPONSE`, never an empty or a final page: the
     * sweep would otherwise read it as "nothing is in scope" and flag every bound issue.
     */
    private suspend fun search(
        client: JiraClient,
        jql: () -> String,
        fields: String,
        progress: RunProgress,
        onPage: suspend (JsonArray) -> Unit,
    ) {
        val ceiling = PageCeiling(JIRA_SOURCE, SEARCH_ENDPOINT, MAX_SEARCH_PAGES)
        val tokens = PageTokenGuard(JIRA_SOURCE, SEARCH_ENDPOINT)
        var token: String? = null
        var restarted = false
        var query = ""
        while (true) {
            progress.beforePage()
            ceiling.next()
            progress.calls++
            if (token == null) query = jql()
            val page = try {
                client.searchJql(query, fields, token, connector.pageSize)
            } catch (failure: FetchException) {
                if (failure.code != CURSOR_EXPIRED || restarted) throw failure
                restarted = true
                token = null
                tokens.restart()
                continue
            }
            val issues = page.issues ?: throw invalidPage("a search page without an issues member")
            if (page.isLast == false && page.nextPageToken == null) throw invalidPage("a search page that is not the last has no token")
            onPage(issues)
            tokens.accept(page.nextPageToken)
            token = page.nextPageToken ?: return
        }
    }

    private fun invalidPage(detail: String) = FetchException(JIRA_SOURCE, "INVALID_RESPONSE", null, SEARCH_ENDPOINT, detail)

    /** The latest instant the connection's reading inputs changed: its last edit or its last real mapping change. */
    private fun changedAt(context: JiraBindContext): Long = maxOf(context.target.expectedUpdatedAt ?: 0L, context.mappingChangedAt ?: 0L)

    private fun idOf(element: Any?): String? =
        ((element as? JsonObject)?.get("id") as? JsonPrimitive)?.contentOrNull?.takeIf(ISSUE_ID_PATTERN::matches)
}
