package ch.nokillswit.sync

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.FailureLog
import ch.nokillswit.infra.catchingFailures
import ch.nokillswit.infra.db.nowMillis
import io.ktor.server.plugins.BadRequestException
import java.util.concurrent.TimeoutException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.slf4j.LoggerFactory

private val log = LoggerFactory.getLogger("ch.nokillswit.sync")

/** The first tick lands this long after start: the application has finished booting, a restart storm does not poll before it settles. */
const val DEFAULT_FIRST_TICK_DELAY_MILLIS = 10_000L

private const val TICK = "tick"

/**
 * The in-process poller (`.claude/docs/observability.md` "Sync runs"; Flow's `ingest/IngestWorker.kt` loop shape, `while (isActive) { tick;
 * delay }`, without its leases): every [tickMillis] it asks each connector for its connections, decides per connection with the pure
 * [decide] over the connection's `sync_runs`, and for a DUE one claims a run (`SCHEDULED`, no requesting user) and hands it to the
 * [runner] like the manual route does.
 *
 * - **Nothing is stored for the schedule.** The due time derives from the connection's rows and its runs, so a restart, a second replica
 *   and a manual refresh (which becomes the newest run) all agree without coordination.
 * - **Replicas.** Every instance ticks and decides alike; the claim's partial unique index (`uq_sync_runs_running`) lets exactly one
 *   INSERT land, the loser gets a [ConflictException] and logs one INFO line. There is no leader and no advisory lock.
 * - **What the manual route checks, the scheduler checks.** Just before the claim it asks the connector's [Connector.requireRunnable] and
 *   re-reads the connection's poll row, so a connection deleted, disabled or made manual-only since the tick's read is skipped; the run
 *   itself re-checks per page and ends `CONNECTION_GONE` / `CONNECTION_DISABLED` for the window that remains.
 * - **A claimed row always gets its run.** The claim and `runner.start` run together in [NonCancellable] (both are short): the tick's
 *   budget or the shutdown can never leave an unfinished row behind with nothing running it (it would block the connection for
 *   `sync.maxRunMinutes`). `runner.start` records the finish even on a cancelled scope.
 * - **A failed connection retries spread, not all at once.** After a shared outage every connection fails in the same tick; [decide] adds
 *   a deterministic per-connection offset to the back-off ([failureJitterMillis]) so the retries do not land in one tick on the two
 *   shared outbound permits. The status reports the same instant (`nextPollAt`).
 * - **A failure never stops the loop.** The tick runs under [tickBudgetMillis]; a connector that throws fails only its own section, one
 *   connection that throws only itself, and each is one WARN then DEBUG then "recovered" ([FailureLog], the exception CLASS only).
 *
 * The loop runs on the runner's scope ([SyncRunner.launch]): `SyncRunner.shutdown` on `ApplicationStopping` ends it, before the pool
 * goes. [clock] is the test seam (the due rule's `now`); the registry's own clock stamps the runs. No log line carries anything but
 * kinds and ids: the scheduler never sees a credential.
 */
class SyncScheduler(
    private val runs: SyncRunService,
    private val runner: SyncRunner,
    private val connectors: SyncConnectors,
    private val tickMillis: Long,
    private val firstTickDelayMillis: Long = DEFAULT_FIRST_TICK_DELAY_MILLIS,
    private val clock: () -> Long = ::nowMillis,
    /** The whole tick's budget: half a tick by default, so a slow database can never make ticks overlap. */
    private val tickBudgetMillis: Long = tickMillis / 2,
    /** The retry spread of a failed connection ([failureJitterFraction]); a test pins it. The status uses the default, so keep it. */
    private val jitter: JitterFraction = ::failureJitterFraction,
) {
    private val failures = FailureLog(log, "Scheduler") { it.javaClass.name }

    /** The loop's job once [start]ed; a test asserts it is completed after the application stops. */
    @Volatile
    var loop: Job? = null
        private set

    /** When the last tick began (epoch millis, the scheduler's clock); null before the first. Read by the telemetry panel (1.3 C3). */
    @Volatile
    var lastTickAt: Long? = null
        private set

    /** Whether the last tick ran to the end with no failure and inside its budget; null before the first. */
    @Volatile
    var lastTickOk: Boolean? = null
        private set

    /** Starts the loop on the runner's scope: the first tick after [firstTickDelayMillis], then one per [tickMillis]. */
    fun start(): Job {
        check(loop == null) { "the scheduler is already started" }
        val job = runner.launch {
            delay(firstTickDelayMillis)
            while (isActive) {
                tick()
                delay(tickMillis)
            }
        }
        loop = job
        return job
    }

    /** One tick; never throws but a cancellation of the scope. `internal` for `SyncSchedulerTest`. */
    internal suspend fun tick() {
        val began = clock()
        // true: every section ran clean; false: a section (or the tick itself) failed and said so under its own name; null: out of budget.
        val outcome = guarded({ withTimeoutOrNull(tickBudgetMillis) { pollConnectors(began) } }) {
            failures.failed(TICK, it)
            false
        }
        if (outcome == null) failures.failed(TICK, TimeoutException("a tick outran its budget")) else if (outcome) failures.ok(TICK)
        lastTickAt = began
        lastTickOk = outcome == true
    }

    /**
     * [catchingFailures] plus the guard of `SyncRunner.execute` ("a timeout a callee leaked"): a [CancellationException] that does NOT come
     * from this coroutine's own cancellation (a `TimeoutCancellationException` leaked by a connector's `withTimeout`) is a failure of the
     * unit, not the end of the loop; when the scope or the tick's budget really cancelled us it is rethrown untouched.
     */
    private suspend inline fun <T> guarded(block: () -> T, onFailure: (Exception) -> T): T =
        try {
            catchingFailures(block, onFailure)
        } catch (leaked: CancellationException) {
            if (!currentCoroutineContext().isActive) throw leaked
            onFailure(leaked)
        }

    private suspend fun pollConnectors(now: Long): Boolean =
        SyncKind.entries.mapNotNull(connectors::of).map { pollConnector(it, now) }.all { it }

    /** One connector's section: false when its reads failed or any of its connections failed to be polled. */
    private suspend fun pollConnector(connector: Connector, now: Long): Boolean {
        val section = connector.kind.name
        val pollable = guarded({ connector.connections().filter { it.enabled && it.ready && it.pollIntervalMinutes != null } }) {
            failures.failed(section, it)
            return false
        }
        // A connection that left the pollable set (deleted, disabled, manual-only, untested) takes its failure state with it.
        failures.forgetExcept("$section connection ", pollable.mapTo(HashSet()) { connectionName(connector, it) })
        val recent = if (pollable.isEmpty()) emptyMap() else guarded({ runs.recentRuns(connector.kind, pollable.map { it.id }) }) {
            failures.failed(section, it)
            return false
        }
        var clean = true
        for (connection in pollable) {
            if (decide(connection, recent[connection.id].orEmpty(), now, runs.maxRunMinutes, jitter) != Decision.Due) continue
            clean = pollOne(connector, connection, now) && clean
        }
        if (clean) failures.ok(section)
        return clean
    }

    private fun connectionName(connector: Connector, connection: ConnectorConnection) = "${connector.kind} connection ${connection.id}"

    private suspend fun pollOne(connector: Connector, connection: ConnectorConnection, now: Long): Boolean {
        val name = connectionName(connector, connection)
        return guarded(
            {
                // Only a run this instance started proves the connection healthy; a skip says nothing and never logs "recovered".
                if (claimAndStart(connector, connection, now)) failures.ok(name)
                true
            },
            {
                failures.failed(name, it)
                false
            },
        )
    }

    /** True when this instance claimed and started a run; false for a skip (no longer due or runnable, or claimed elsewhere). */
    private suspend fun claimAndStart(connector: Connector, connection: ConnectorConnection, now: Long): Boolean {
        if (!stillDue(connector, connection, now)) return false
        return try {
            withContext(NonCancellable) {
                val claimed = runs.claim(connector.kind, connection.id, SyncTrigger.SCHEDULED, null)
                runner.start(connector, claimed)
                log.info("Scheduler started run {} for {} connection {}", claimed.id, connector.kind, connection.id)
            }
            true
        } catch (_: ConflictException) {
            log.info(
                "Scheduler: {} connection {} is claimed elsewhere (another instance or a refresh), skipped",
                connector.kind, connection.id,
            )
            false
        }
    }

    /**
     * The last look before the claim: the connector's own runnable check (what the manual route asks: unknown, deleted or disabled is a
     * `BadRequestException`), then the connection's poll row AND its runs once more through the same pure rule (made manual-only,
     * untested or edited since the tick's read; a run another replica or a refresh claimed and finished meanwhile). False skips the
     * connection quietly; the next tick decides afresh.
     */
    private suspend fun stillDue(connector: Connector, connection: ConnectorConnection, now: Long): Boolean {
        try {
            connector.requireRunnable(connection.id)
        } catch (_: BadRequestException) {
            log.info("Scheduler: {} connection {} is no longer runnable, skipped", connector.kind, connection.id)
            return false
        }
        val fresh = connector.connections().firstOrNull { it.id == connection.id } ?: return false
        val facts = runs.recentRuns(connector.kind, listOf(connection.id))[connection.id].orEmpty()
        return decide(fresh, facts, now, runs.maxRunMinutes, jitter) == Decision.Due
    }
}
