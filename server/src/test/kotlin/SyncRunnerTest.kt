package ch.nokillswit

import ch.nokillswit.sync.ClaimedRun
import ch.nokillswit.sync.Connector
import ch.nokillswit.sync.ConnectorConnection
import ch.nokillswit.sync.SyncCounts
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncResult
import ch.nokillswit.sync.SyncRunResponse
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.sync.SyncRunServiceKey
import ch.nokillswit.sync.SyncRunnerKey
import ch.nokillswit.sync.describeWithoutMessage
import ch.nokillswit.sync.runDeadlineMillis
import io.ktor.server.testing.testApplication
import ch.nokillswit.sync.SyncRunner
import ch.nokillswit.sync.SyncTrigger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Every way a background run can end, against fake connectors and the real registry: the connector's own result, an unexpected
 * exception, the deadline, the application shutdown (the row is written inside `NonCancellable` and the cancellation is NOT swallowed)
 * and a run that is no longer in flight. Runs are awaited through `SyncRunner.await` - no sleeps.
 */
class SyncRunnerTest {
    private val connections = mutableListOf<UInt>()
    private val scopes = mutableListOf<CoroutineScope>()
    private val runs = SyncRunService(sharedDatabaseForTests(), maxRunMinutes = 10)

    @AfterTest
    fun cleanup() {
        scopes.forEach { it.cancel() }
        connections.forEach { jbSql("DELETE FROM sync_runs WHERE connection_id = ?", it.toInt()) }
    }

    private fun scope() = CoroutineScope(SupervisorJob() + Dispatchers.IO).also { scopes += it }

    private fun connection(): UInt = ThreadLocalRandom.current().nextInt(1_000_000, Int.MAX_VALUE).toUInt().also { connections += it }

    private fun connector(body: suspend (ClaimedRun) -> SyncResult) = object : Connector {
        override val kind = SyncKind.JIRA
        override suspend fun requireRunnable(connectionId: UInt) = Unit
        override suspend fun connections() = emptyList<ConnectorConnection>()
        override suspend fun run(run: ClaimedRun) = body(run)
    }

    private suspend fun SyncRunner.execute(connector: Connector, id: UInt): SyncRunResponse {
        val claimed = runs.claim(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)
        start(connector, claimed)
        withTimeout(30_000) { await(claimed.id) }
        return runs.list(SyncKind.JIRA, id).single { it.id == claimed.id }
    }

    @Test
    fun `the connector's result is stored, success and typed failure alike`() = runBlocking {
        val runner = SyncRunner(scope(), runs)
        val ok = runner.execute(connector { SyncResult.succeeded(SyncCounts(observed = 3, calls = 2)) }, connection())
        assertEquals(SyncOutcome.SUCCEEDED, ok.outcome)
        assertEquals(3, ok.observedCount)
        val failed = runner.execute(connector { SyncResult.failed("MAPPING_INVALID", "No issue type at hierarchy level 7") }, connection())
        assertEquals(SyncOutcome.FAILED, failed.outcome)
        assertEquals("MAPPING_INVALID", failed.errorCode)
        assertTrue(failed.finishedAt != null)
    }

    @Test
    fun `an unexpected exception finishes the run FAILED INTERNAL with the class name only, and frees the connection`() = runBlocking {
        val runner = SyncRunner(scope(), runs)
        val id = connection()
        val row = runner.execute(connector { error("secret detail https://x.test/?token=abc") }, id)
        assertEquals(SyncOutcome.FAILED, row.outcome)
        assertEquals("INTERNAL", row.errorCode)
        assertEquals("IllegalStateException", row.errorDetail)
        // The claim is free again: another run goes through.
        assertEquals(SyncOutcome.SUCCEEDED, runner.execute(connector { SyncResult.succeeded(SyncCounts()) }, id).outcome)
    }

    @Test
    fun `a run past its deadline is cut and finished FAILED RUN_DEADLINE`() = runBlocking {
        val runner = SyncRunner(scope(), runs, deadlineMillis = 200)
        val row = runner.execute(connector { awaitCancellation() }, connection())
        assertEquals(SyncOutcome.FAILED, row.outcome)
        assertEquals("RUN_DEADLINE", row.errorCode)
    }

    @Test
    fun `a shutdown finishes every in-flight run FAILED SHUTDOWN and does not swallow the cancellation`() = runBlocking {
        val runnerScope = scope()
        val runner = SyncRunner(runnerScope, runs)
        val started = CompletableDeferred<Unit>()
        val sawCancellation = AtomicBoolean(false)
        val hanging = connector {
            started.complete(Unit)
            try {
                awaitCancellation()
            } catch (cancelled: CancellationException) {
                sawCancellation.set(true)
                throw cancelled
            }
        }
        val id = connection()
        val claimed = runs.claim(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)
        runner.start(hanging, claimed)
        withTimeout(30_000) { started.await() }
        runner.shutdown()
        assertTrue(sawCancellation.get(), "the connector saw the cancellation")
        val row = runs.list(SyncKind.JIRA, id).single()
        assertEquals(SyncOutcome.FAILED, row.outcome)
        assertEquals("SHUTDOWN", row.errorCode)
        assertTrue(runnerScope.coroutineContext[Job]!!.isCancelled)
        // A run that starts on the stopped runner still records its end (ATOMIC start): never a row left unfinished by shutdown.
        val late = runs.claim(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)
        runner.start(connector { SyncResult.succeeded(SyncCounts()) }, late)
        withTimeout(30_000) { runner.await(late.id) }
        assertTrue(runs.list(SyncKind.JIRA, id).single { it.id == late.id }.outcome != null)
    }

    @Test
    fun `a timeout a callee leaked is a RUN_DEADLINE of its own, not a shutdown`() = runBlocking {
        val runner = SyncRunner(scope(), runs)
        val row = runner.execute(connector { withTimeout(10) { awaitCancellation() } }, connection())
        assertEquals(SyncOutcome.FAILED, row.outcome)
        assertEquals("RUN_DEADLINE", row.errorCode)
        assertEquals("A step of the run timed out", row.errorDetail)
    }

    @Test
    fun `the deadline is under the claim's lifetime for every setting, with a floor of half a minute`() {
        assertEquals(30_000L, runDeadlineMillis(1), "one minute: the floor, not zero")
        assertEquals(9 * 60_000L, runDeadlineMillis(10))
        assertTrue((1..60).all { runDeadlineMillis(it) < it * 60_000L }, "a live run never outlives its claim")
    }

    @Test
    fun `an unexpected failure is described by its classes and frames, never its message`() {
        val cause = RuntimeException("Key (x)=(secret) exists")
        val text = describeWithoutMessage(IllegalStateException("value 'secret summary' violates", cause))
        assertTrue("IllegalStateException <- java.lang.RuntimeException" in text, text)
        assertFalse("secret" in text, text)
    }

    @Test
    fun `stopping the application finishes a run in flight as SHUTDOWN - configureSync's ApplicationStopping subscription`() {
        val id = connection()
        lateinit var claimed: ClaimedRun
        testApplication {
            configureApp()
            startApplication()
            val started = CompletableDeferred<Unit>()
            claimed = application.attributes[SyncRunServiceKey].claim(SyncKind.JIRA, id, SyncTrigger.MANUAL, null)
            application.attributes[SyncRunnerKey].start(connector { started.complete(Unit).let { awaitCancellation() } }, claimed)
            withTimeout(30_000) { started.await() }
        } // the application stops here
        val row = runBlocking { runs.list(SyncKind.JIRA, id).single { it.id == claimed.id } }
        assertEquals(SyncOutcome.FAILED, row.outcome)
        assertEquals("SHUTDOWN", row.errorCode)
    }

    @Test
    fun `awaiting a run that is not in flight returns at once`() = runBlocking {
        SyncRunner(scope(), runs).await(999_999_999u)
        assertNull(runs.lastSucceededStart(SyncKind.JIRA, connection()))
    }
}
