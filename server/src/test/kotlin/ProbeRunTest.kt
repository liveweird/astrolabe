package ch.nokillswit

import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.jira.JIRA_SOURCE
import ch.nokillswit.jira.ProbeFailure
import ch.nokillswit.jira.ProbeRun
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The probe harness: every outcome is a row, a genuine cancellation is not, and the 10 s / 30 s budgets hold. */
class ProbeRunTest {

    @Test
    fun `every kind of failure becomes a row and the run goes on`() = runBlocking {
        val run = ProbeRun(now = { 0L })
        run.probe("ok", "/a", required = true, scopeHint = "read:a") {}
        run.probe("fetch", "/b", required = true, scopeHint = "read:b") { throw FetchException(JIRA_SOURCE, "FORBIDDEN_SCOPE", 403, "/b") }
        run.probe("verdict", "/c", required = false) { throw ProbeFailure("PROJECT_NOT_VISIBLE") }
        run.probe("gateway", "/d", required = true) { throw IllegalStateException("resolveCloudId() must run first") }
        run.probe("cast", "/e", required = true) { throw IllegalArgumentException("not an object") }
        run.probe("oops", "/f", required = true) { throw UnsupportedOperationException("anything unexpected") }
        assertEquals(
            listOf(
                "ok" to null, "fetch" to "FORBIDDEN_SCOPE", "verdict" to "PROJECT_NOT_VISIBLE", "gateway" to "NOT_FOUND",
                "cast" to "INVALID_RESPONSE", "oops" to "INVALID_RESPONSE",
            ),
            run.rows.map { it.name to it.code },
        )
        assertEquals(listOf(true, false, false, false, false, false), run.rows.map { it.ok })
        assertEquals(403, run.rows[1].status)
        assertEquals("read:b", run.rows[1].scopeHint)
        assertFalse(run.rows[2].required)
    }

    @Test
    fun `a probe over its own timeout is a TIMEOUT row`() = runBlocking {
        val run = ProbeRun(now = { 0L }, probeTimeoutMs = 50)
        run.probe("slow", "/slow", required = true) { delay(5_000) }
        assertEquals("TIMEOUT", run.rows.single().code)
    }

    @Test
    fun `the total budget erodes across probes - once spent every further probe is a TIMEOUT row without running`() = runBlocking {
        var clock = 0L
        val run = ProbeRun(now = { clock }, totalBudgetMs = 100)
        var ran = 0
        run.probe("first", "/a", required = true) { ran++; clock += 150 }
        run.probe("second", "/b", required = true) { ran++ }
        assertEquals(1, ran)
        assertEquals(listOf(true, false), run.rows.map { it.ok })
        assertEquals("TIMEOUT", run.rows[1].code)
    }

    @Test
    fun `a genuine cancellation propagates instead of becoming a row`() {
        val run = ProbeRun(now = { 0L })
        assertFailsWith<CancellationException> {
            runBlocking { run.probe("cancelled", "/a", required = true) { throw CancellationException("the caller went away") } }
        }
        assertTrue(run.rows.isEmpty())
    }
}
