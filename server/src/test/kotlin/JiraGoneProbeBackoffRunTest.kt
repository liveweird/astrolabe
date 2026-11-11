package ch.nokillswit

import ch.nokillswit.jira.JiraBindingResponse
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.sync.SyncTrigger
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import org.slf4j.LoggerFactory
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The gone probe's back-off (`GoneProbeDamper`, 1.13) at run level, over a scripted `MockEngine`: three bindings the sweep judges gone
 * whose by-id read fails with a 500, two the sweep still lists. Scheduled runs (and the clock, moved by hours) are the poller's; the
 * sync logger runs at DEBUG for the test so the quiet lines can be told from the loud ones. The clock ticks at least a millisecond per
 * reading, so the order in which reads failed is unambiguous.
 */
class JiraGoneProbeBackoffRunTest {
    companion object {
        private const val HOUR = 3_600_000L

        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }

    private class Fixture(val w: PlanWorld, val connectionId: UInt, val bound: List<JiraBindingResponse>)

    /** A connection with E2E-4..E2E-8 bound as milestones (binding ids ascend in that order). */
    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
        val w = planWorld(prefix, teams = true)
        val connectionId = w.admin.client.jbConnection(jbRequest()).id
        return Fixture(w, connectionId, bindFive(w, connectionId))
    }

    private suspend fun bindFive(w: PlanWorld, connectionId: UInt): List<JiraBindingResponse> {
        val teamId = w.requireTeams().teamId
        return (4..8).map {
            w.admin.client.jbBind(connectionId, JiraLevel.MILESTONE, TestPlan.milestone(w.projectId, teamId), "E2E-$it").jbBinding()
        }
    }

    /** What one run did: the bindings read by id (as indices into the fixture's bindings, in order) and the probe's log lines. */
    private class Run(val reads: List<Int>, val lines: List<String>)

    /**
     * The scripted site and its clock. Indices [0, 1, 2] are gone for the sweep at the start; [listed] are the ones it still lists;
     * [answering] are the ones whose by-id read answers 404 (the rest answer 500), and [okKey] makes a read a 200 carrying that key.
     */
    private inner class Rig(app: Application, var f: Fixture) : AutoCloseable {
        var offset = 0L
        private val clock = AtomicLong()
        var listed = f.bound.drop(3).map { it.issueId }
        var answering = emptySet<String>()
        var okKey: String? = null
        private val logger = LoggerFactory.getLogger("ch.nokillswit.sync") as ch.qos.logback.classic.Logger
        private val levelBefore = logger.level
        private val log: LogCapture
        private var seen = 0
        val mock: MockJiraRun

        init {
            logger.level = ch.qos.logback.classic.Level.DEBUG
            log = LogCapture("ch.nokillswit.sync")
            mock = MockJiraRun(app, now = { clock.updateAndGet { maxOf(it + 1, System.currentTimeMillis() + offset) } }) { request ->
                when {
                    request.isIssueRead() -> when {
                        okKey != null -> jsonOk("""{"id":"${request.issueId()}","key":"$okKey"}""")
                        request.issueId() in answering -> failure(HttpStatusCode.NotFound)
                        else -> failure(HttpStatusCode.InternalServerError)
                    }
                    // The sweep lists [listed]; the child level's id listing (stories) lists nothing.
                    request.url.parameters["fields"] == "id" ->
                        jsonOk(if (request.isChildListing()) idsPage() else idsPage(*listed.toTypedArray()))
                    else -> jsonOk(searchPage())
                }
            }
        }

        suspend fun run(hours: Long = 0, trigger: SyncTrigger = SyncTrigger.SCHEDULED): Run {
            offset = hours * HOUR
            val before = mock.requests.size
            val result = mock.run(f.connectionId, trigger)
            assertEquals(SyncOutcome.SUCCEEDED, result.outcome, result.errorDetail)
            val reads = mock.requests.drop(before).filter { it.isIssueRead() }
                .map { read -> f.bound.indexOfFirst { it.issueId == read.issueId() } }
            val fresh = log.events.drop(seen)
            seen += fresh.size
            val lines = fresh.mapNotNull { event -> kindOf(event.formattedMessage)?.let { "${event.level} $it" } }
            fresh.filter { kindOf(it.formattedMessage) != null }.forEach { event ->
                val text = event.formattedMessage
                assertTrue(listOf("E2E-", "OUT-").none { it in text }, "no probe line carries a key: $text")
            }
            return Run(reads, lines)
        }

        override fun close() {
            log.detach()
            logger.level = levelBefore
        }
    }

    private fun kindOf(message: String): String? = when {
        "probe of issue" in message -> "issue"
        "probe stopped after" in message -> "breaker"
        "gone probe got no answer" in message -> "tripped"
        "gone probe answers again" in message -> "recovered"
        else -> null
    }

    private fun HttpRequestData.isIssueRead() = url.encodedPath.contains("/rest/api/3/issue/")

    private fun HttpRequestData.isChildListing() = "10001,10002,10003" in url.parameters["jql"].orEmpty()

    private fun HttpRequestData.issueId() = url.encodedPath.substringAfterLast('/')

    /** Three failed reads under their first-time WARNs and the breaker's WARN: a streak's first failing run. */
    private val loud = List(3) { "WARN issue" } + "WARN breaker"

    /** The same three failed reads and the breaker, after the first failing run. */
    private val quiet = List(3) { "DEBUG issue" } + "DEBUG breaker"

    /** A Refresh now after the first failing run: a WARN per failed read (the operator asked), the breaker quiet. */
    private val manualLines = List(3) { "WARN issue" } + "DEBUG breaker"

    private fun reasonOf(binding: JiraBindingResponse): Pair<Boolean, String?> =
        jbScalar("SELECT gone, gone_reason FROM jira_observations WHERE binding_id = ?", binding.id.toInt()) {
            it.getBoolean(1) to it.getString(2)
        }

    private fun probedAtOf(binding: JiraBindingResponse): Long? =
        jbScalar("SELECT gone_probed_at FROM jira_observations WHERE binding_id = ?", binding.id.toInt()) {
            it.getLong(1).takeUnless { _ -> it.wasNull() }
        }

    private fun keyOf(binding: JiraBindingResponse): String? =
        jbScalar("SELECT gone_probed_key FROM jira_observations WHERE binding_id = ?", binding.id.toInt()) { it.getString(1) }

    private fun bindingKeyOf(binding: JiraBindingResponse): String =
        jbScalar("SELECT jira_issue_key FROM jira_bindings WHERE id = ?", binding.id.toInt()) { it.getString(1) }

    private suspend fun apiReason(f: Fixture, binding: JiraBindingResponse): String? {
        val row = jbJson.decodeFromString<JiraBindingResponse>(f.w.admin.client.get("$JB_BINDINGS/${binding.id}").bodyAsText())
        return assertNotNull(row.observation).goneReason
    }

    /** The first three scheduled runs: 3 failed reads each, the loud lines once, then the quiet ones, and the trip's WARN on the third. */
    private suspend fun Rig.trip() {
        assertEquals(listOf(0, 1, 2), run().reads)
        assertEquals(listOf(0, 1, 2), run().reads)
        assertEquals(listOf(0, 1, 2), run().reads)
    }

    @Test
    fun `a probe that gets no answer is retried for three runs, then asked once a day, and Refresh now asks at once`() = testApplication {
        val f = fixture("jrbtable")
        Rig(application, f).use { rig ->
            val first = rig.run()
            assertEquals(listOf(0, 1, 2), first.reads)
            assertEquals(loud, first.lines, "a first attempt: a WARN per binding and the breaker's WARN")
            val second = rig.run()
            assertEquals(listOf(0, 1, 2), second.reads)
            assertEquals(quiet, second.lines, "the same bindings, the same streak: DEBUG only")
            val third = rig.run()
            assertEquals(listOf(0, 1, 2), third.reads)
            assertEquals(quiet + "WARN tripped", third.lines, "the third run in a row trips: one WARN")

            // Tripped: a scheduled run asks nothing for a day (the three are due on every run otherwise).
            val gated = rig.run(23)
            assertEquals(emptyList(), gated.reads)
            assertEquals(emptyList(), gated.lines, "and logs nothing")
            assertEquals(emptyList(), rig.run(23).reads)

            // A day on, the scheduled run retries once more - DEBUG - and the clock restarts.
            val retry = rig.run(25)
            assertEquals(listOf(0, 1, 2), retry.reads)
            assertEquals(quiet, retry.lines, "no second trip line")
            assertEquals(emptyList(), rig.run(25).reads, "the retry restarted the clock")

            // Refresh now bypasses the gate and warns per failed read; it neither counts nor restarts the retry clock (still the 25 h one).
            val manual = rig.run(40, SyncTrigger.MANUAL)
            assertEquals(listOf(0, 1, 2), manual.reads)
            assertEquals(manualLines, manual.lines)
            assertEquals(emptyList(), rig.run(40).reads, "the scheduled run after it is gated again")
            val later = rig.run(50)
            assertEquals(listOf(0, 1, 2), later.reads, "a day after the 25 h retry: the manual run did not restart the clock")
            assertEquals(quiet, later.lines)
            f.bound.take(3).forEach { assertEquals(true to "OUT_OF_SCOPE", reasonOf(it)) }
        }
    }

    @Test
    fun `a binding that vanishes while the probe is tripped is asked at once, and an answer ends the streak`() = testApplication {
        val f = fixture("jrbnew")
        Rig(application, f).use { rig ->
            rig.trip()
            val (b3, b4) = f.bound.drop(3)

            // b3 vanishes: newly flagged, so asked in the run that flags it (and only it); its read fails, the streak goes on.
            rig.listed = listOf(b4.issueId)
            val vanish = rig.run()
            assertEquals(listOf(3), vanish.reads)
            assertEquals(listOf("WARN issue"), vanish.lines)
            assertEquals(emptyList(), rig.run().reads, "b3 is now a retry like the three: gated")

            // b4 vanishes and Jira answers 404 for it: an answer, so the streak ends, once.
            rig.listed = emptyList()
            rig.answering = setOf(b4.issueId)
            val answered = rig.run()
            assertEquals(listOf(4), answered.reads)
            assertEquals(listOf("INFO recovered"), answered.lines)
            assertEquals(true to "DELETED", reasonOf(b4))

            // Not tripped any more: the next run asks the four unanswered again, the least recently tried first (b3 failed last).
            val again = rig.run()
            assertEquals(listOf(0, 1, 2), again.reads, "three failures, the breaker; b3 waits behind them")
            assertEquals(loud, again.lines, "a new streak warns afresh")
            assertEquals(true to "OUT_OF_SCOPE", reasonOf(b3), "b3 is still gone and unanswered")
            assertNull(probedAtOf(b3))
        }
    }

    @Test
    fun `the first answering run after a failing streak logs one INFO, and nothing more once everything is answered`() = testApplication {
        val f = fixture("jrbinfo")
        Rig(application, f).use { rig ->
            rig.trip()
            rig.answering = f.bound.take(3).map { it.issueId }.toSet()
            val recovered = rig.run(25)
            assertEquals(listOf(0, 1, 2), recovered.reads)
            assertEquals(listOf("INFO recovered"), recovered.lines)
            f.bound.take(3).forEach { assertEquals(true to "DELETED", reasonOf(it)) }
            val after = rig.run(25)
            assertEquals(emptyList(), after.reads, "verdicts are final")
            assertEquals(emptyList(), after.lines)
        }
    }

    @Test
    fun `a connection edit forgets the streak - the next run asks and warns as a first attempt, counting afresh`() = testApplication {
        val f = fixture("jrbedit")
        Rig(application, f).use { rig ->
            rig.trip()
            assertEquals(emptyList(), rig.run().reads, "tripped")
            jbSql("UPDATE jira_connections SET updated_at = ? WHERE id = ?", System.currentTimeMillis(), f.connectionId.toInt())
            val edited = rig.run()
            assertEquals(listOf(0, 1, 2), edited.reads, "the edit lifts the gate")
            assertEquals(loud, edited.lines, "and the warnings start over")
            assertEquals(quiet, rig.run().lines, "the second failing run of the new streak")
            assertEquals(quiet + "WARN tripped", rig.run().lines, "the third trips again")
            assertEquals(emptyList(), rig.run().reads)
        }
    }

    @Test
    fun `bindings whose read keeps failing queue behind the others, so three stuck ones do not starve the rest`() = testApplication {
        val f = fixture("jrbrotate")
        Rig(application, f).use { rig ->
            rig.listed = emptyList() // all five are gone and unanswered; the first three (lowest ids) are stuck, the last two answer 404
            rig.answering = f.bound.drop(3).map { it.issueId }.toSet()
            val first = rig.run(trigger = SyncTrigger.MANUAL)
            assertEquals(listOf(0, 1, 2), first.reads, "by binding id the stuck ones come first and trip the breaker")
            assertEquals(loud, first.lines)
            val second = rig.run(trigger = SyncTrigger.MANUAL)
            assertEquals(listOf(3, 4, 0, 1, 2), second.reads, "the least recently tried first: the two never tried, then the stuck ones")
            assertEquals(loud, second.lines, "no run counted (a manual run without an answer does not), so the stuck ones warn again")
            assertEquals(listOf(true to "DELETED", true to "DELETED"), f.bound.drop(3).map { reasonOf(it) })
            assertEquals(listOf(0, 1, 2), rig.run(trigger = SyncTrigger.MANUAL).reads, "the answered two are final")
        }
    }

    @Test
    fun `a re-ask that fails keeps the former answer and the row stays due - or gated once the probe is tripped`() = testApplication {
        val f = fixture("jrbreask")
        Rig(application, f).use { rig ->
            val item = f.bound[0]
            rig.listed = f.bound.drop(1).map { it.issueId }
            rig.okKey = "OUT-71"
            assertEquals(listOf(0), rig.run().reads)
            val answeredAt = assertNotNull(probedAtOf(item))
            assertEquals("OUT-71", keyOf(item))
            assertEquals("MOVED_OUT", apiReason(f, item))

            // A day on, the re-ask fails: nothing of the former answer changes.
            rig.okKey = null
            val failed = rig.run(25)
            assertEquals(listOf(0), failed.reads)
            assertEquals(listOf("WARN issue"), failed.lines)
            fun assertFormerAnswer() {
                assertEquals(answeredAt, probedAtOf(item), "the stamp stands")
                assertEquals("OUT-71", keyOf(item))
                assertEquals("OUT-71", bindingKeyOf(item))
                assertEquals(true to "OUT_OF_SCOPE", reasonOf(item))
            }
            assertFormerAnswer()
            assertEquals("MOVED_OUT", apiReason(f, item))

            // It is still due: the next scheduled run asks again (twice more, which trips the damper).
            assertEquals(listOf(0), rig.run(26).reads)
            val trips = rig.run(27)
            assertEquals(listOf(0), trips.reads)
            assertEquals(listOf("DEBUG issue", "WARN tripped"), trips.lines)
            assertFormerAnswer()

            // Tripped: it is due but gated, until a day after the last retry - or Refresh now.
            assertEquals(emptyList(), rig.run(27).reads)
            assertFormerAnswer()
            rig.okKey = "OUT-72"
            val back = rig.run(52)
            assertEquals(listOf(0), back.reads)
            assertEquals(listOf("INFO recovered"), back.lines)
            assertEquals("OUT-72", keyOf(item))
            assertTrue(assertNotNull(probedAtOf(item)) > answeredAt, "restamped")
        }
    }

    @Test
    fun `five stuck bindings, more than the breaker takes - per-issue WARNs only in the first failing run, then one trip WARN`() =
        testApplication {
            val f = fixture("jrbfive")
            Rig(application, f).use { rig ->
                rig.listed = emptyList() // all five are gone and every read fails
                val first = rig.run()
                assertEquals(listOf(0, 1, 2), first.reads, "the newly flagged, by id, until the breaker")
                assertEquals(loud, first.lines, "the streak's first failing run: a WARN per tried binding and the breaker's")

                // The rotation moves on to the two never tried: DEBUG only, whichever binding it reaches.
                val second = rig.run()
                assertEquals(listOf(3, 4, 0), second.reads, "never tried first, then the least recently tried")
                assertEquals(quiet, second.lines, "no WARN rotates through the other stuck bindings")
                val third = rig.run()
                assertEquals(listOf(1, 2, 3), third.reads)
                assertEquals(quiet + "WARN tripped", third.lines, "the single trip WARN, on the third failing run")

                // Tripped: nothing is newly flagged, so a scheduled run asks nothing and logs nothing.
                val gated = rig.run()
                assertEquals(emptyList(), gated.reads)
                assertEquals(emptyList(), gated.lines, "no per-issue line for ranks 1 and 2 while gated")
                assertEquals(emptyList(), rig.run(23).lines)
            }
        }

    @Test
    fun `a due readable item is asked ahead of stuck rows that were tried, and its answer is recorded`() = testApplication {
        val f = fixture("jrbcross")
        Rig(application, f).use { rig ->
            val readable = f.bound[3]
            // Run 1: only the readable one vanishes; Jira answers 200 (a key outside the projects).
            rig.listed = listOf(0, 1, 2, 4).map { f.bound[it].issueId }
            rig.okKey = "OUT-90"
            assertEquals(listOf(3), rig.run().reads)
            val answeredAt = assertNotNull(probedAtOf(readable))
            assertEquals(true to "OUT_OF_SCOPE", reasonOf(readable))

            // Run 2, a day on: three more vanish and fail; they are newly flagged, so they go first and fill the breaker.
            rig.okKey = null
            rig.listed = listOf(f.bound[4].issueId)
            val second = rig.run(25)
            assertEquals(listOf(0, 1, 2), second.reads, "the readable item is due but behind the newly flagged")
            assertEquals(loud, second.lines)

            // Run 3: the three are stuck rank-1 rows that were tried; the due readable one is asked ahead of them, and its 404 is kept.
            rig.answering = setOf(readable.issueId)
            val third = rig.run(26)
            assertEquals(listOf(3, 0, 1, 2), third.reads, "not starved by the stuck rank-1 rows")
            assertEquals(quiet, third.lines)
            assertEquals(true to "DELETED", reasonOf(readable))
            assertTrue(assertNotNull(probedAtOf(readable)) > answeredAt, "restamped by the answer")
        }
    }

    @Test
    fun `a manual run without an answer does not count toward the trip, its per-issue lines are WARN`() = testApplication {
        val f = fixture("jrbmanual")
        Rig(application, f).use { rig ->
            assertEquals(loud, rig.run().lines)
            val manual = rig.run(trigger = SyncTrigger.MANUAL)
            assertEquals(listOf(0, 1, 2), manual.reads)
            assertEquals(manualLines, manual.lines, "a WARN per failed read, the breaker quiet")
            // Had the manual run counted, this second SCHEDULED run would be the third in a row and trip.
            assertEquals(quiet, rig.run().lines)
            assertEquals(quiet + "WARN tripped", rig.run().lines, "the third scheduled failing run trips")
        }
    }

    @Test
    fun `a manual run that gets an answer ends a tripped streak, once, and the next scheduled run warns afresh`() = testApplication {
        val f = fixture("jrbmanans")
        Rig(application, f).use { rig ->
            rig.trip()
            rig.answering = setOf(f.bound[0].issueId)
            val manual = rig.run(trigger = SyncTrigger.MANUAL)
            assertEquals(listOf(0, 1, 2), manual.reads)
            assertEquals(listOf("WARN issue", "WARN issue", "INFO recovered"), manual.lines, "two fail (no breaker); the streak ends")
            assertEquals(true to "DELETED", reasonOf(f.bound[0]))
            val next = rig.run()
            assertEquals(listOf(1, 2), next.reads, "no longer tripped: the unanswered are asked on a scheduled run again")
            assertEquals(listOf("WARN issue", "WARN issue"), next.lines, "a new streak warns afresh")
        }
    }

    @Test
    fun `the recovered INFO needs a tripped streak - none after one failing run and then an answer`() = testApplication {
        val f = fixture("jrbrecov")
        Rig(application, f).use { rig ->
            assertEquals(loud, rig.run().lines)
            rig.answering = f.bound.take(3).map { it.issueId }.toSet()
            val answered = rig.run()
            assertEquals(listOf(0, 1, 2), answered.reads)
            assertEquals(emptyList(), answered.lines, "one failing run is no streak worth announcing the end of")
            f.bound.take(3).forEach { assertEquals(true to "DELETED", reasonOf(it)) }
        }
    }

    @Test
    fun `a run with nothing bound forgets the streak, so bindings made afterwards start a new one`() = testApplication {
        val f = fixture("jrbempty")
        Rig(application, f).use { rig ->
            rig.trip()
            f.bound.forEach { assertEquals(HttpStatusCode.NoContent, f.w.admin.client.delete("$JB_BINDINGS/${it.id}").status) }
            val empty = rig.run()
            assertEquals(emptyList(), empty.reads)
            assertEquals(emptyList(), empty.lines)

            rig.f = Fixture(f.w, f.connectionId, bindFive(f.w, f.connectionId))
            rig.listed = emptyList()
            val fresh = rig.run()
            assertEquals(listOf(0, 1, 2), fresh.reads)
            assertEquals(loud, fresh.lines, "a first failing run again: the breaker warns")
            assertEquals(listOf(3, 4, 0), rig.run().reads, "and the retry ranks are not gated")
        }
    }
}
