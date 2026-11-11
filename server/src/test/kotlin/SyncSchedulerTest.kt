package ch.nokillswit

import ch.nokillswit.flow.CapacityAcknowledgeService
import ch.nokillswit.flow.CapacityDeviationService
import ch.nokillswit.flow.FlowClient
import ch.nokillswit.flow.FlowConnectionService
import ch.nokillswit.flow.FlowConnector
import ch.nokillswit.flow.FlowMe
import ch.nokillswit.flow.FlowMirrorStore
import ch.nokillswit.flow.FlowObserver
import ch.nokillswit.flow.FlowTeamBindingService
import ch.nokillswit.flow.FlowTeamsDocument
import ch.nokillswit.sync.ClaimedRun
import ch.nokillswit.sync.Connector
import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.sync.JitterFraction
import ch.nokillswit.sync.NO_JITTER
import ch.nokillswit.sync.SyncConnectors
import ch.nokillswit.sync.SyncCounts
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncResult
import ch.nokillswit.sync.SyncRunResponse
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.sync.SyncRunner
import ch.nokillswit.sync.SyncScheduler
import ch.nokillswit.sync.SyncState
import ch.nokillswit.sync.SyncStatusKernels
import ch.nokillswit.sync.SyncTrigger
import ch.nokillswit.sync.failureJitterFraction
import io.ktor.server.plugins.BadRequestException
import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The scheduler against the REAL run registry (`SyncRunService` over the shared container) and a fake connector, with an injected clock:
 * the cadence and the back-off row by row, a config change, a run in flight, two instances ticking together (the unique index gives one
 * row), a connector or a connection that throws, the tick's budget, the loop and the shutdown - and in every one of them no secret
 * reaches a log line. Ticks are driven by hand (`tick()`); only the loop and shutdown tests start the real loop.
 */
class SyncSchedulerTest {
    private companion object {
        const val FLOW_PREFIX = "schedflow"
    }

    private val minute = 60_000L
    private val t0 = 1_700_000_000_000L
    private val now = AtomicLong(t0)
    private val runs = SyncRunService(sharedDatabaseForTests(), maxRunMinutes = 10, clock = now::get)
    private val ids = mutableListOf<UInt>()
    private val scopes = mutableListOf<CoroutineScope>()
    private val captures = mutableListOf<LogCapture>()
    private val secret = "JTOK-${java.util.UUID.randomUUID()}"

    private val runnerScope = CoroutineScope(SupervisorJob() + Dispatchers.IO).also { scopes += it }
    private val runner = SyncRunner(runnerScope, runs)

    @AfterTest
    fun cleanup() {
        captures.forEach { it.detach() }
        scopes.forEach { it.cancel() }
        ids.forEach { jbSql("DELETE FROM sync_runs WHERE connection_id = ?", it.toInt()) }
        removeFlowFixtureRows(FLOW_PREFIX)
    }

    private class FakeConnector : Connector {
        override val kind = SyncKind.JIRA

        @Volatile
        var rows: List<ConnectorConnection> = emptyList()

        @Volatile
        var listing: suspend () -> List<ConnectorConnection> = { rows }

        @Volatile
        var check: suspend (UInt) -> Unit = {}

        /** The claim's own lock: throws `BadRequestException` for a connection deleted since the check. */
        @Volatile
        var lock: suspend (UInt) -> Unit = {}

        @Volatile
        var body: suspend (ClaimedRun) -> SyncResult = { SyncResult.succeeded(SyncCounts()) }
        val runCalls = AtomicInteger()

        override suspend fun requireRunnable(connectionId: UInt) = check(connectionId)

        override suspend fun lockActiveInTransaction(connectionId: UInt) = lock(connectionId)

        override suspend fun connections(): List<ConnectorConnection> = listing()

        override suspend fun run(run: ClaimedRun): SyncResult {
            runCalls.incrementAndGet()
            return body(run)
        }
    }

    private fun connectionId(): UInt = ThreadLocalRandom.current().nextInt(1_000_000, Int.MAX_VALUE).toUInt().also { ids += it }

    private fun conn(id: UInt, interval: Int? = 15, enabled: Boolean = true, ready: Boolean = true, changedAt: Long = t0 - 60 * minute) =
        ConnectorConnection(id, "c$id", enabled, interval, ready, changedAt)

    private fun capture(): LogCapture = LogCapture("ch.nokillswit.sync").also { captures += it }

    private fun scheduler(
        connector: Connector,
        runner: SyncRunner = this.runner,
        tickMillis: Long = 50,
        budgetMillis: Long = 30_000,
        jitter: JitterFraction = NO_JITTER, // the back-off rows below pin exact instants; the jitter tests pass their own
    ): SyncScheduler {
        val connectors = SyncConnectors().also { it.register(connector) }
        return SyncScheduler(
            runs, runner, connectors, tickMillis, firstTickDelayMillis = 0, clock = now::get, tickBudgetMillis = budgetMillis,
            jitter = jitter,
        )
    }

    private suspend fun rows(id: UInt): List<SyncRunResponse> = runs.list(SyncKind.JIRA, id)

    /** Waits for every run of [ids] still in flight on [runner] to write its finish. */
    private suspend fun settle(vararg ids: UInt, runner: SyncRunner = this.runner) =
        withTimeout(30_000) { ids.forEach { id -> rows(id).forEach { runner.await(it.id) } } }

    private suspend fun SyncScheduler.tickAndSettle(vararg ids: UInt) {
        tick()
        settle(*ids)
    }

    private fun at(minutes: Long, extraMillis: Long = 0) = now.set(t0 + minutes * minute + extraMillis)

    private fun LogCapture.lines(level: ch.qos.logback.classic.Level) = events.filter { it.level == level }.map { it.formattedMessage }

    private fun LogCapture.assertNoSecret() {
        val text = events.joinToString("\n") { event ->
            event.formattedMessage + " " + event.throwableProxy?.message.orEmpty() + " " + event.keyValuePairs.orEmpty().joinToString()
        }
        assertFalse(secret in text, "a secret reached a log line:\n$text")
    }

    @Test
    fun `a due connection gets exactly one SCHEDULED run with no requesting user and is left alone until its interval has passed`() =
        runBlocking {
            val id = connectionId()
            val fake = FakeConnector().apply { rows = listOf(conn(id)) }
            val scheduler = scheduler(fake)
            val log = capture()

            scheduler.tickAndSettle(id)

            val first = rows(id).single()
            assertEquals(SyncTrigger.SCHEDULED, first.trigger)
            assertNull(first.requestedByUserId)
            assertEquals(SyncOutcome.SUCCEEDED, first.outcome)
            assertEquals(1, fake.runCalls.get())
            val started = "Scheduler started run ${first.id} for JIRA connection $id"
            assertTrue(log.lines(ch.qos.logback.classic.Level.INFO).any { it == started })
            assertEquals(true, scheduler.lastTickOk)
            assertEquals(t0, scheduler.lastTickAt)

            at(14, 59_999)
            scheduler.tickAndSettle(id)
            assertEquals(1, rows(id).size, "one millisecond short of the interval")
            at(15)
            scheduler.tickAndSettle(id)
            assertEquals(2, rows(id).size)
            assertEquals(2, fake.runCalls.get())
        }

    @Test
    fun `a tested Flow connection is polled through the real Flow connector, an untested or failing one is not`() = runBlocking {
        val database = sharedDatabaseForTests()
        val connections = FlowConnectionService(database, flowTestCipher, runs, anyFlowOrigin)
        val asked = AtomicInteger()
        val client = object : FlowClient {
            override suspend fun me(): FlowMe = error("a run never calls me")

            override suspend fun teams(sprintsSince: java.time.LocalDate): FlowTeamsDocument {
                asked.incrementAndGet()
                return FlowTeamsDocument(1L, sprintsSince.toString(), teamsTruncated = false, sprintsTruncated = false, items = emptyList())
            }
        }
        val mirror = FlowMirrorStore(database)
        val flowBindings = FlowTeamBindingService(database)
        val acknowledgements = CapacityAcknowledgeService(
            database, CapacityDeviationService(database, flowBindings, mirror, capacityService(database), runs), flowBindings, mirror,
        )
        val observer = FlowObserver(
            FlowConnector({ _, _ -> client }, sprintsSinceDays = 365), connections, mirror, flowBindings, acknowledgements,
        )
        suspend fun connection(testOk: Boolean?): UInt {
            val id = connections.create(flowRequest(name = flowUnique(FLOW_PREFIX)))
            if (testOk != null) {
                val target = checkNotNull(connections.readForTest(id))
                assertTrue(connections.recordTest(id, target.expectedUpdatedAt, testOk, at = System.currentTimeMillis()))
            }
            return id
        }
        val tested = connection(true)
        val untested = connection(null)
        val failing = connection(false)
        // The shared database holds other tests' Flow connections: the scheduler sees only this test's three, so it claims (and counts
        // calls for) nothing else.
        val mine = setOf(tested, untested, failing)
        val scoped = object : Connector by observer {
            override suspend fun connections(): List<ConnectorConnection> = observer.connections().filter { it.id in mine }

            override suspend fun connections(queryTimeoutSeconds: Int): List<ConnectorConnection> = connections()
        }
        val scheduler = scheduler(scoped)

        scheduler.tick()
        withTimeout(30_000) { runs.list(SyncKind.FLOW, tested).forEach { runner.await(it.id) } }

        val polled = runs.list(SyncKind.FLOW, tested).single()
        assertEquals(Pair(SyncTrigger.SCHEDULED, SyncOutcome.SUCCEEDED), Pair(polled.trigger, polled.outcome))
        assertEquals(1, asked.get(), "one call for the one pollable connection")
        val unpolled = runs.list(SyncKind.FLOW, untested) + runs.list(SyncKind.FLOW, failing)
        assertEquals(emptyList(), unpolled, "never tested, or the test failed")
        assertEquals(SyncState.CURRENT, connections.read(tested)!!.status.state)
        assertEquals(SyncState.NEVER_SYNCED, connections.read(untested)!!.status.state)
    }

    @Test
    fun `a disabled, untested or manual-only connection is never claimed`() = runBlocking {
        val (disabled, untested, manual) = listOf(connectionId(), connectionId(), connectionId())
        val fake = FakeConnector().apply {
            rows = listOf(conn(disabled, enabled = false), conn(untested, ready = false), conn(manual, interval = null))
        }
        val scheduler = scheduler(fake)
        scheduler.tickAndSettle(disabled, untested, manual)
        assertEquals(0, fake.runCalls.get())
        assertEquals(emptyList(), listOf(disabled, untested, manual).flatMap { rows(it) })
        assertEquals(true, scheduler.lastTickOk)
    }

    @Test
    fun `a run in flight blocks the poll, and one left unfinished by a crash is abandoned by the next poll`() = runBlocking {
        val id = connectionId()
        val fake = FakeConnector().apply { rows = listOf(conn(id)) }
        val scheduler = scheduler(fake)
        val inFlight = runs.claimUnchecked(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)

        at(9, 59_000)
        scheduler.tickAndSettle(id)
        assertEquals(0, fake.runCalls.get(), "a manual run younger than the claim's lifetime blocks the poll")
        assertEquals(listOf(inFlight.id), rows(id).map { it.id })

        at(11) // older than sync.maxRunMinutes: the process that held it is gone
        scheduler.tickAndSettle(id)
        val listed = rows(id)
        assertEquals(2, listed.size)
        assertEquals(SyncOutcome.ABANDONED, listed.single { it.id == inFlight.id }.outcome)
        assertEquals(SyncTrigger.SCHEDULED, listed.first { it.id != inFlight.id }.trigger)
        assertEquals(1, fake.runCalls.get())
    }

    @Test
    fun `a failed run's retry is pushed back by the jitter, to the millisecond, and a success is not`() = runBlocking {
        val id = connectionId()
        val fake = FakeConnector().apply {
            rows = listOf(conn(id))
            body = { SyncResult.failed("BOOM") }
        }
        // Half the span: min(backoff / 2, interval / 2) = 7.5 min at 15 minutes, so 3 min 45 s.
        val scheduler = scheduler(fake, jitter = { _, _ -> 0.5 })

        scheduler.tickAndSettle(id)
        at(15, 224_999)
        scheduler.tickAndSettle(id)
        assertEquals(1, rows(id).size, "one interval is not enough: the jitter is added")
        at(15, 225_000)
        scheduler.tickAndSettle(id)
        assertEquals(2, rows(id).size)

        // Two failures: the second retry waits 30 min plus half of min(30 / 2, 7.5) = 7.5 min after the second run finished (now).
        fake.body = { SyncResult.succeeded(SyncCounts()) }
        val secondFinished = now.get()
        now.set(secondFinished + 30 * minute + 225_000 - 1)
        scheduler.tickAndSettle(id)
        assertEquals(2, rows(id).size, "the second retry waits two intervals plus the jitter")
        now.set(secondFinished + 30 * minute + 225_000)
        scheduler.tickAndSettle(id)
        assertEquals(SyncOutcome.SUCCEEDED, rows(id).first().outcome)

        val succeededAt = now.get()
        now.set(succeededAt + 15 * minute - 1)
        scheduler.tickAndSettle(id)
        assertEquals(3, rows(id).size)
        now.set(succeededAt + 15 * minute)
        scheduler.tickAndSettle(id)
        assertEquals(4, rows(id).size, "a success is back to the plain interval, no jitter")
    }

    @Test
    fun `the status reports the instant the scheduler really claims, with the production jitter`() = runBlocking {
        val id = connectionId()
        val fake = FakeConnector().apply {
            rows = listOf(conn(id))
            body = { SyncResult.failed("BOOM") }
        }
        val scheduler = scheduler(fake, jitter = ::failureJitterFraction)
        scheduler.tickAndSettle(id)

        val facts = runs.recentRuns(SyncKind.JIRA, listOf(id)).getValue(id)
        val reported = assertNotNull(SyncStatusKernels.derive(conn(id), facts, now.get(), 10).nextPollAt)
        assertTrue(reported >= t0 + 15 * minute && reported < t0 + 15 * minute + 450_000, "one interval plus less than half of it")
        now.set(reported - 1)
        scheduler.tickAndSettle(id)
        assertEquals(1, rows(id).size, "not a millisecond before nextPollAt")
        now.set(reported)
        scheduler.tickAndSettle(id)
        assertEquals(2, rows(id).size, "exactly at nextPollAt")
    }

    @Test
    fun `after a failed run the next poll waits one interval, after two failures two, and a success resets`() = runBlocking {
        val id = connectionId()
        val fake = FakeConnector().apply {
            rows = listOf(conn(id))
            body = { SyncResult.failed("BOOM") }
        }
        val scheduler = scheduler(fake)

        scheduler.tickAndSettle(id)
        assertEquals(1, rows(id).size)
        at(14, 59_999)
        scheduler.tickAndSettle(id)
        assertEquals(1, rows(id).size, "the first retry waits one interval")
        at(15)
        scheduler.tickAndSettle(id)
        assertEquals(2, rows(id).size)

        at(15 + 29, 59_999)
        scheduler.tickAndSettle(id)
        assertEquals(2, rows(id).size, "two failures in a row wait two intervals")
        at(15 + 30)
        scheduler.tickAndSettle(id)
        assertEquals(3, rows(id).size)

        fake.body = { SyncResult.succeeded(SyncCounts()) }
        at(15 + 30 + 59, 59_999)
        scheduler.tickAndSettle(id)
        assertEquals(3, rows(id).size, "three failures wait four intervals")
        at(15 + 30 + 60)
        scheduler.tickAndSettle(id)
        assertEquals(SyncOutcome.SUCCEEDED, rows(id).first().outcome)

        at(15 + 30 + 60 + 14, 59_999)
        scheduler.tickAndSettle(id)
        assertEquals(4, rows(id).size, "a success is back to the plain interval")
        at(15 + 30 + 60 + 15)
        scheduler.tickAndSettle(id)
        assertEquals(5, rows(id).size)
    }

    @Test
    fun `a change to the connection after the last run makes it due at once, even in the middle of a back-off`() = runBlocking {
        val id = connectionId()
        val fake = FakeConnector().apply {
            rows = listOf(conn(id))
            body = { SyncResult.failed("AUTHENTICATION_FAILED") }
        }
        val scheduler = scheduler(fake)
        scheduler.tickAndSettle(id)
        assertEquals(1, rows(id).size)

        at(1)
        scheduler.tickAndSettle(id)
        assertEquals(1, rows(id).size, "still backing off")
        fake.rows = listOf(conn(id, changedAt = t0 + 30_000)) // the admin fixed the token
        scheduler.tickAndSettle(id)
        assertEquals(2, rows(id).size)
    }

    @Test
    fun `two instances ticking together over one registry produce one run, and the loser says so`() = runBlocking {
        val id = connectionId()
        val arrivals = AtomicInteger()
        val bothAtTheClaim = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val fake = FakeConnector().apply {
            rows = listOf(conn(id))
            // Each instance has decided "due", passed its last look (stillDue, which reads the runs) and opened its claim
            // transaction; neither inserts before the other has got here. A barrier any earlier (at requireRunnable) lets the
            // winner commit before the loser's last look, which then skips quietly instead of meeting the unique index.
            lock = {
                if (arrivals.incrementAndGet() == 2) bothAtTheClaim.complete(Unit)
                bothAtTheClaim.await()
            }
            // The winner's run stays unfinished until both ticks are over, so the loser's INSERT meets the unique index.
            body = {
                release.await()
                SyncResult.succeeded(SyncCounts())
            }
        }
        val log = capture()
        val one = scheduler(fake)
        val other = scheduler(fake)

        withTimeout(60_000) {
            coroutineScope {
                launch(Dispatchers.IO) { one.tick() }
                launch(Dispatchers.IO) { other.tick() }
            }
        }
        release.complete(Unit)
        settle(id)

        assertEquals(1, rows(id).size)
        assertEquals(1, fake.runCalls.get())
        val info = log.lines(ch.qos.logback.classic.Level.INFO)
        assertEquals(1, info.count { "Scheduler started run" in it && "connection $id" in it })
        assertEquals(1, info.count { "connection $id is claimed elsewhere" in it }, "$info")
        assertEquals(listOf(true, true), listOf(one.lastTickOk, other.lastTickOk), "losing the claim is not a failure")
    }

    @Test
    fun `a connection disabled, deleted or made manual-only between the read and the claim is not claimed`() = runBlocking {
        val manual = connectionId()
        val deleted = connectionId()
        val disabled = connectionId()
        val log = capture()

        // The tick's read sees it due; the last look finds it manual-only / gone.
        val reads = AtomicInteger()
        val fake = FakeConnector().apply {
            listing = {
                val first = reads.incrementAndGet() == 1
                if (first) {
                    listOf(conn(manual), conn(deleted), conn(disabled))
                } else {
                    listOf(conn(manual, interval = null), conn(disabled))
                }
            }
            check = { if (it == disabled) throw BadRequestException("Unknown or disabled") }
        }
        val scheduler = scheduler(fake)
        scheduler.tickAndSettle(manual, deleted, disabled)

        assertEquals(0, fake.runCalls.get())
        assertEquals(emptyList(), listOf(manual, deleted, disabled).flatMap { rows(it) })
        assertTrue(log.lines(ch.qos.logback.classic.Level.INFO).any { "JIRA connection $disabled is no longer runnable" in it })
        assertEquals(true, scheduler.lastTickOk, "a refusal is a skip, not a failure")
    }

    @Test
    fun `a connection deleted after the last look but before the claim's lock is skipped and leaves no run`() = runBlocking {
        val gone = connectionId()
        val log = capture()
        val fake = FakeConnector().apply {
            rows = listOf(conn(gone))
            lock = { throw BadRequestException("Unknown or disabled") } // the delete committed between requireRunnable and the claim
        }
        val scheduler = scheduler(fake)
        scheduler.tickAndSettle(gone)

        assertEquals(0, fake.runCalls.get())
        assertEquals(emptyList(), rows(gone), "the refused claim wrote nothing")
        assertTrue(log.lines(ch.qos.logback.classic.Level.INFO).any { "JIRA connection $gone was deleted before the claim" in it })
        assertEquals(true, scheduler.lastTickOk, "a deleted connection is a skip, not a failure")
    }

    @Test
    fun `a connection that throws fails only itself, once in the log, and never leaks the exception text`() = runBlocking {
        val broken = connectionId()
        val healthy = connectionId()
        val fake = FakeConnector().apply {
            rows = listOf(conn(broken), conn(healthy))
            check = { if (it == broken) error("the token $secret was refused") }
        }
        val scheduler = scheduler(fake)
        val log = capture()

        scheduler.tickAndSettle(broken, healthy)
        assertEquals(1, rows(healthy).size, "the other connection still runs")
        assertEquals(emptyList(), rows(broken))
        assertEquals(false, scheduler.lastTickOk)
        val warnings = log.lines(ch.qos.logback.classic.Level.WARN).filter { "Scheduler" in it }
        assertEquals(listOf("Scheduler JIRA connection $broken failed: java.lang.IllegalStateException"), warnings)

        at(1)
        scheduler.tickAndSettle(broken, healthy) // broken again: no second WARN
        assertEquals(1, log.lines(ch.qos.logback.classic.Level.WARN).count { "Scheduler" in it })
        log.assertNoSecret()
    }

    @Test
    fun `a connector that throws costs one WARN, then recovers, and the loop keeps ticking through it`() = runBlocking {
        val id = connectionId()
        val calls = AtomicInteger()
        val fake = FakeConnector().apply {
            listing = {
                if (calls.incrementAndGet() <= 3) error("the connector cannot read: $secret") else listOf(conn(id))
            }
        }
        val log = capture()
        val scheduler = scheduler(fake)

        val loop = scheduler.start()
        withTimeout(60_000) { while (rows(id).isEmpty() || scheduler.lastTickOk != true) delay(25) }
        settle(id)

        assertTrue(loop.isActive, "three failed ticks did not stop the loop")
        assertEquals(1, log.lines(ch.qos.logback.classic.Level.WARN).count { "Scheduler JIRA failed" in it })
        assertEquals(1, log.lines(ch.qos.logback.classic.Level.INFO).count { "Scheduler JIRA recovered" in it })
        log.assertNoSecret()
    }

    @Test
    fun `a timeout leaked by a connector fails its unit, not the loop`() = runBlocking {
        val broken = connectionId()
        val healthy = connectionId()
        val fake = FakeConnector().apply { listing = { withTimeout(10) { awaitCancellation() } } }
        val log = capture()
        val scheduler = scheduler(fake)

        scheduler.tick() // the connector's own withTimeout leaks a TimeoutCancellationException out of connections()
        assertEquals(false, scheduler.lastTickOk)
        assertEquals(
            listOf("Scheduler JIRA failed: kotlinx.coroutines.TimeoutCancellationException"),
            log.lines(ch.qos.logback.classic.Level.WARN).filter { "Scheduler" in it },
        )

        // The same leak from one connection's last look costs only that connection; the next tick runs the other.
        fake.listing = { listOf(conn(broken), conn(healthy)) }
        fake.check = { if (it == broken) withTimeout(10) { awaitCancellation() } }
        scheduler.tickAndSettle(broken, healthy)
        assertEquals(1, rows(healthy).size)
        assertEquals(emptyList(), rows(broken))
        assertEquals(false, scheduler.lastTickOk)

        fake.check = {}
        at(1)
        scheduler.tickAndSettle(broken, healthy)
        assertEquals(1, rows(broken).size, "later ticks still run")

        // And the real loop survives it: it keeps ticking past a leaked timeout and reaches the next good tick.
        val id = connectionId()
        val calls = AtomicInteger()
        fake.listing = { if (calls.incrementAndGet() <= 2) withTimeout(10) { awaitCancellation() } else listOf(conn(id)) }
        val loop = scheduler.start()
        withTimeout(45_000) { while (rows(id).isEmpty()) delay(25) }
        settle(id)
        assertTrue(loop.isActive)
    }

    @Test
    fun `a skip is neither a recovery nor a failure, and a connection that drops out starts over with a WARN`() = runBlocking {
        val id = connectionId()
        val fake = FakeConnector().apply {
            rows = listOf(conn(id))
            check = { error("the last look failed") }
        }
        val log = capture()
        val scheduler = scheduler(fake)
        fun warnings() = log.lines(ch.qos.logback.classic.Level.WARN).count { "connection $id failed" in it }
        fun recoveries() = log.lines(ch.qos.logback.classic.Level.INFO).count { "connection $id recovered" in it }

        scheduler.tick()
        assertEquals(1, warnings())

        fake.check = { throw BadRequestException("disabled meanwhile") } // a skip: says nothing about the failure
        scheduler.tick()
        assertEquals(0, recoveries(), "a skipped connection did not recover")
        assertEquals(1, warnings())

        fake.rows = emptyList() // the connection is deleted (or disabled, or made manual-only): its failure state goes with it
        scheduler.tick()
        fake.rows = listOf(conn(id))
        fake.check = { error("the last look failed again") }
        scheduler.tick()
        assertEquals(2, warnings(), "a new episode warns again")
        assertEquals(0, recoveries())

        fake.check = {}
        scheduler.tickAndSettle(id)
        assertEquals(1, recoveries(), "only a run this instance started proves it healthy")
    }

    @Test
    fun `a run another instance claimed and finished since the tick's read is seen at the last look`() = runBlocking {
        val id = connectionId()
        val fake = FakeConnector().apply { rows = listOf(conn(id)) }
        fake.check = { // the other replica gets in between the read and the claim, and its run is already over
            val other = runs.claimUnchecked(SyncKind.JIRA, it, SyncTrigger.SCHEDULED, null)
            runs.finish(other.id, SyncResult.succeeded(SyncCounts()))
        }
        val log = capture()
        val scheduler = scheduler(fake)

        scheduler.tickAndSettle(id)

        assertEquals(1, rows(id).size, "only the other instance's run")
        assertEquals(0, fake.runCalls.get())
        assertTrue(log.lines(ch.qos.logback.classic.Level.INFO).none { "Scheduler started run" in it && "connection $id" in it })
    }

    @Test
    fun `a tick that outruns its budget is cut and logged, and the next tick runs`() = runBlocking {
        val id = connectionId()
        val fake = FakeConnector().apply { listing = { awaitCancellation() } }
        val log = capture()
        val scheduler = scheduler(fake, budgetMillis = 100)

        scheduler.tick()
        assertEquals(false, scheduler.lastTickOk)
        assertEquals(listOf("Scheduler tick failed: java.util.concurrent.TimeoutException"), log.lines(ch.qos.logback.classic.Level.WARN))

        fake.listing = { listOf(conn(id)) }
        scheduler.tickAndSettle(id)
        assertEquals(1, rows(id).size)
        assertEquals(true, scheduler.lastTickOk)
        assertEquals(listOf("Scheduler tick recovered"), log.lines(ch.qos.logback.classic.Level.INFO).filter { "recovered" in it })
    }

    @Test
    fun `shutting the runner down ends the loop and records SHUTDOWN on a scheduled run in flight`() = runBlocking {
        val id = connectionId()
        val started = CompletableDeferred<Unit>()
        val fake = FakeConnector().apply {
            rows = listOf(conn(id))
            body = {
                started.complete(Unit)
                awaitCancellation()
            }
        }
        val scheduler = scheduler(fake)
        val loop = scheduler.start()
        withTimeout(60_000) { started.await() }

        runner.shutdown()

        assertTrue(loop.isCompleted, "the scheduler's loop is gone with the runner's scope")
        val row = rows(id).single()
        assertEquals(SyncTrigger.SCHEDULED, row.trigger)
        assertEquals(SyncOutcome.FAILED, row.outcome)
        assertEquals("SHUTDOWN", row.errorCode)
        // Nothing starts after the stop: the loop is gone, so nothing ticks any more.
        val before = fake.runCalls.get()
        delay(200)
        assertEquals(before, fake.runCalls.get())
    }
}
