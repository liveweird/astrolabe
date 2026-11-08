package ch.nokillswit.sync

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.catchingFailures
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.plugins.isUniqueViolation
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.slf4j.LoggerFactory

val SyncRunServiceKey = AttributeKey<SyncRunService>("SyncRunService")

private val log = LoggerFactory.getLogger("ch.nokillswit.sync")

private const val MILLIS_PER_MINUTE = 60_000L
private const val MAX_ERROR_DETAIL = 500
private const val MAX_ERROR_CODE = 40

/**
 * The run registry (V21 `sync_runs`): who is running what, and how each run ended. It writes ONLY its own table and reads no other. A
 * run is claimed by INSERTing its unfinished row - the partial unique index `uq_sync_runs_running` admits one per (kind, connection), so
 * of any number of replicas that tick together exactly one INSERT lands and the others get a `409` (manual) or the scheduler's
 * INFO "claimed elsewhere" line. There is no lock beyond that index and no timer: a process that died with a run unfinished is cleaned
 * up by the NEXT claim, which finishes any unfinished row older than [maxRunMinutes] as `ABANDONED` (the run's own deadline is shorter,
 * so a live run is never abandoned under itself). The rows are operational history, pruned to the last [MAX_LISTED_RUNS] per connection
 * at claim time.
 */
class SyncRunService(
    private val database: R2dbcDatabase,
    /** `sync.maxRunMinutes`: how long a claim stays valid before another claim may abandon it. */
    val maxRunMinutes: Int,
    private val clock: () -> Long = ::nowMillis,
) {
    object Runs : UIntIdTable("sync_runs") {
        val kind = varchar("kind", length = 10)
        val connectionId = integer("connection_id")
        val trigger = varchar("trigger", length = 10)
        val requestedByUserId = long("requested_by_user_id").nullable()
        val startedAt = long("started_at")
        val finishedAt = long("finished_at").nullable()
        val outcome = varchar("outcome", length = 12).nullable()
        val errorCode = varchar("error_code", length = MAX_ERROR_CODE).nullable()
        val errorDetail = varchar("error_detail", length = MAX_ERROR_DETAIL).nullable()
        val observedCount = integer("observed_count").default(0)
        val goneCount = integer("gone_count").default(0)
        val callCount = integer("call_count").default(0)
        val rateLimitedCount = integer("rate_limited_count").default(0)
        val backoffMs = long("backoff_ms").default(0)
    }

    /**
     * Claims a run: in ONE transaction, finishes any unfinished run of the (kind, connection) older than [maxRunMinutes] as `ABANDONED`,
     * prunes the finished ones to leave room for this one, then INSERTs the unfinished row. A `23505` on the unique index means another
     * run holds the claim: `409 run-in-progress`.
     */
    suspend fun claim(kind: SyncKind, connectionId: UInt, trigger: SyncTrigger, byUserId: UInt?): ClaimedRun {
        val startedAt = clock()
        var abandoned = 0
        val claimed = catchingFailures(
            {
                suspendTransaction(database) {
                    abandoned = abandonStale(kind, connectionId, startedAt)
                    prune(kind, connectionId)
                    val id = Runs.insert {
                        it[Runs.kind] = kind.name
                        it[Runs.connectionId] = connectionId.toInt()
                        it[Runs.trigger] = trigger.name
                        it[requestedByUserId] = byUserId?.toLong()
                        it[Runs.startedAt] = startedAt
                    }[Runs.id].value
                    ClaimedRun(id, kind, connectionId, trigger, byUserId, startedAt)
                }
            },
            { failure ->
                if (failure.isUniqueViolation()) {
                    throw ConflictException("A ${kind.name} sync is already running for this connection", RUN_IN_PROGRESS_PROBLEM)
                }
                throw failure
            },
        )
        // After the commit: a claim that rolled back (the 409) abandoned nothing.
        if (abandoned > 0) log.warn(
            "Abandoned {} unfinished {} run(s) of {} older than {} min",
            abandoned, kind, connectionId, maxRunMinutes,
        )
        return claimed
    }

    private suspend fun abandonStale(kind: SyncKind, connectionId: UInt, now: Long): Int =
        Runs.update(
            {
                (Runs.kind eq kind.name) and (Runs.connectionId eq connectionId.toInt()) and Runs.finishedAt.isNull() and
                    (Runs.startedAt less now - maxRunMinutes * MILLIS_PER_MINUTE)
            },
        ) {
            it[finishedAt] = now
            it[outcome] = SyncOutcome.ABANDONED.name
            it[errorCode] = SyncErrorCodes.ABANDONED
            it[errorDetail] = "The run did not finish within $maxRunMinutes minutes"
        }

    /** Keeps the newest `MAX_LISTED_RUNS - 1` FINISHED runs of the (kind, connection): the run being inserted is the last of the 50. */
    private suspend fun prune(kind: SyncKind, connectionId: UInt) {
        val scope = (Runs.kind eq kind.name) and (Runs.connectionId eq connectionId.toInt()) and Runs.finishedAt.isNotNull()
        val keep = Runs.select(Runs.id).where { scope }
            .orderBy(Runs.startedAt to SortOrder.DESC, Runs.id to SortOrder.DESC).limit(MAX_LISTED_RUNS - 1)
        Runs.deleteWhere { scope and (Runs.id notInSubQuery keep) }
    }

    /**
     * Finishes run [runId] with [result]; [SyncResult.errorDetail] is clamped to 500 characters with every URL and credential masked
     * ([clampErrorDetail]). Touches only a run that is still unfinished: the late finish of a run another claim already abandoned is a
     * no-op (false), so it can never rewrite what the abandonment recorded.
     */
    suspend fun finish(runId: UInt, result: SyncResult): Boolean = suspendTransaction(database) {
        val counts = result.counts
        Runs.update({ (Runs.id eq runId) and Runs.finishedAt.isNull() }) {
            it[finishedAt] = clock()
            it[outcome] = result.outcome.name
            it[errorCode] = result.errorCode?.take(MAX_ERROR_CODE)
            it[errorDetail] = clampErrorDetail(result.errorDetail)
            it[observedCount] = counts.observed
            it[goneCount] = counts.gone
            it[callCount] = counts.calls
            it[rateLimitedCount] = counts.rateLimited
            it[backoffMs] = counts.backoffMs
        } == 1
    }

    /**
     * Removes every run of the (kind, connection), INSIDE the caller's open transaction (it opens none). A run still in flight
     * keeps going until its next write: its [finish] then finds no row and answers false.
     */
    suspend fun deleteForConnectionInTransaction(kind: SyncKind, connectionId: UInt): Int =
        deleteForConnectionInTransaction(kind.name, connectionId)

    /**
     * [deleteForConnectionInTransaction] by the kind's stored NAME, for a connector whose [SyncKind] value has not landed yet: the V21
     * CHECK already admits `'FLOW'`, and a connection delete must clear that connection's runs (none exist until the Flow run does). The
     * typed overload replaces the one caller when `SyncKind.FLOW` is added.
     */
    suspend fun deleteForConnectionInTransaction(kindName: String, connectionId: UInt): Int =
        Runs.deleteWhere { (Runs.kind eq kindName) and (Runs.connectionId eq connectionId.toInt()) }

    /** The `started_at` of the newest SUCCEEDED run of the (kind, connection): the incremental watermark; null before the first. */
    suspend fun lastSucceededStart(kind: SyncKind, connectionId: UInt): Long? = suspendTransaction(database) {
        Runs.select(Runs.startedAt)
            .where {
                (Runs.kind eq kind.name) and (Runs.connectionId eq connectionId.toInt()) and
                    (Runs.outcome eq SyncOutcome.SUCCEEDED.name)
            }
            .orderBy(Runs.startedAt to SortOrder.DESC).limit(1).toList().singleOrNull()?.get(Runs.startedAt)
    }

    /** The newest runs first, at most [MAX_LISTED_RUNS]; each filter is optional. */
    suspend fun list(kind: SyncKind?, connectionId: UInt?): List<SyncRunResponse> = suspendTransaction(database) {
        var predicate: Op<Boolean> = Op.TRUE
        kind?.let { predicate = predicate and (Runs.kind eq it.name) }
        connectionId?.let { predicate = predicate and (Runs.connectionId eq it.toInt()) }
        Runs.selectAll().where { predicate }.orderBy(Runs.startedAt to SortOrder.DESC, Runs.id to SortOrder.DESC)
            .limit(MAX_LISTED_RUNS).toList().map { it.toResponse() }
    }

    /**
     * The policy's view of each connection's runs, newest first (by start, then id), at most [limit] per connection, read INSIDE the
     * caller's open transaction - it opens none. One indexed `LIMIT` query per connection (`idx_sync_runs_connection`); a connection
     * with no run maps to an empty list. [RunFact] carries the columns the due rule and the status read and nothing else (no error text).
     */
    suspend fun recentRunsInTransaction(
        kind: SyncKind,
        connectionIds: Collection<UInt>,
        limit: Int = MAX_LISTED_RUNS,
    ): Map<UInt, List<RunFact>> = connectionIds.associateWith { id ->
        Runs.select(Runs.id, Runs.trigger, Runs.startedAt, Runs.finishedAt, Runs.outcome, Runs.errorCode)
            .where { (Runs.kind eq kind.name) and (Runs.connectionId eq id.toInt()) }
            .orderBy(Runs.startedAt to SortOrder.DESC, Runs.id to SortOrder.DESC).limit(limit).toList()
            .map {
                RunFact(
                    it[Runs.startedAt], it[Runs.finishedAt], it[Runs.outcome]?.let(SyncOutcome::valueOf),
                    it[Runs.id].value, SyncTrigger.valueOf(it[Runs.trigger]), it[Runs.errorCode],
                )
            }
    }

    /**
     * [recentRunsInTransaction] in a transaction of its own: one snapshot for the whole batch of connections, under a statement budget of
     * [queryTimeoutSeconds] (whole seconds; 0 = none, the default).
     */
    suspend fun recentRuns(
        kind: SyncKind,
        connectionIds: Collection<UInt>,
        limit: Int = MAX_LISTED_RUNS,
        queryTimeoutSeconds: Int = 0,
    ): Map<UInt, List<RunFact>> = suspendTransaction(database) {
        queryTimeout = queryTimeoutSeconds
        recentRunsInTransaction(kind, connectionIds, limit)
    }

    /**
     * THE rule for "running" (the run list, the connection's `lastRun` and the Deviations view all read it): the row is unfinished and was
     * claimed less than [maxRunMinutes] before [now]. Older, an unfinished row was interrupted and the next claim will abandon it.
     */
    fun isRunning(finishedAt: Long?, startedAt: Long, now: Long): Boolean = isRunLive(finishedAt, startedAt, now, maxRunMinutes)

    /** The registry's clock (epoch millis): the "now" a status is derived against, so one injected clock governs every age. */
    fun now(): Long = clock()

    private fun ResultRow.toResponse() = SyncRunResponse(
        id = this[Runs.id].value,
        kind = SyncKind.valueOf(this[Runs.kind]),
        connectionId = this[Runs.connectionId].toUInt(),
        trigger = SyncTrigger.valueOf(this[Runs.trigger]),
        requestedByUserId = this[Runs.requestedByUserId]?.toUInt(),
        startedAt = this[Runs.startedAt],
        finishedAt = this[Runs.finishedAt],
        outcome = this[Runs.outcome]?.let(SyncOutcome::valueOf),
        errorCode = this[Runs.errorCode],
        errorDetail = this[Runs.errorDetail],
        running = isRunning(this[Runs.finishedAt], this[Runs.startedAt], clock()),
        observedCount = this[Runs.observedCount],
        goneCount = this[Runs.goneCount],
        callCount = this[Runs.callCount],
        rateLimitedCount = this[Runs.rateLimitedCount],
        backoffMs = this[Runs.backoffMs],
    )
}

/** The response for a run just claimed (its row is unfinished, every counter zero). */
fun ClaimedRun.toResponse() = SyncRunResponse(
    id = id, kind = kind, connectionId = connectionId, trigger = trigger, requestedByUserId = byUserId, startedAt = startedAt,
    finishedAt = null, outcome = null, errorCode = null, errorDetail = null, running = true,
    observedCount = 0, goneCount = 0, callCount = 0, rateLimitedCount = 0, backoffMs = 0,
)

private val URL_PATTERN = Regex("""(?i)\b[a-z][a-z0-9+.-]*://\S*""")
private val AUTH_HEADER_PATTERN = Regex("""(?i)\b(basic|bearer)\s+\S+""")
private val QUERY_PATTERN = Regex("""\?\S*""")
private val CONTROL_RUN = Regex("""[\p{Cntrl}\s]+""")

/**
 * A run's error text as it may be STORED and shown to every signed-in user: every URL becomes `[url]`, an `Authorization` value
 * `Basic|Bearer [redacted]`, any remaining `?query` is dropped, control characters and runs of whitespace collapse to one space, and the
 * result is cut to 500 characters (never in the middle of a surrogate pair). Null for a null or blank text. The run's own code builds its
 * details from endpoint PATHS and error codes, so this is the backstop that keeps a future message from leaking one.
 */
internal fun clampErrorDetail(text: String?): String? {
    if (text == null) return null
    val masked = QUERY_PATTERN.replace(
        AUTH_HEADER_PATTERN.replace(URL_PATTERN.replace(text, "[url]")) { "${it.groupValues[1]} [redacted]" },
        "",
    )
    val tidy = CONTROL_RUN.replace(masked, " ").trim()
    if (tidy.isEmpty()) return null
    val cut = tidy.take(MAX_ERROR_DETAIL)
    return if (cut.length < tidy.length && cut.last().isHighSurrogate()) cut.dropLast(1) else cut
}
