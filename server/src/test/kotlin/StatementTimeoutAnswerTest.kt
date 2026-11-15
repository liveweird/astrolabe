package ch.nokillswit

import ch.nokillswit.infra.db.R2dbcDatabaseKey
import ch.nokillswit.jira.jiraPollRows
import ch.nokillswit.plugins.DATABASE_TIMEOUT_PROBLEM
import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.plugins.isQueryCanceled
import ch.nokillswit.planning.WorkStreamCreateRequest
import ch.nokillswit.sync.SyncKind
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.users.UserRole
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import io.r2dbc.spi.R2dbcNonTransientResourceException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The pool-wide statement limit and its answer (1.23.0, `postgres.statementTimeoutSeconds`, `persistence.md` "Connection pool"): a
 * statement the database does not finish is cancelled (SQLSTATE 57014) and answers the existing `500` with
 * `type: urn:astrolabe:problem:database-timeout`, one WARN with the method and the path, no audit event; a save that was cut has
 * written nothing. Flow's `ReportQueryBudgetTest` idea: a lock held by a SECOND session is the deterministic "slow statement". The
 * limit is 1 second here; every lock is released in a `finally`.
 */
class StatementTimeoutAnswerTest {

    /**
     * Runs [block] while a second JDBC session holds the lock [lockSql] takes; it is always rolled back (released) afterwards. A cap
     * releases it anyway after [LOCK_CAP_MS], so a limit that is NOT enforced fails the assertion instead of hanging the fork.
     */
    private suspend fun <T> withLocked(lockSql: String, block: suspend () -> T): T = coroutineScope {
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            val cap = launch(Dispatchers.IO) {
                delay(LOCK_CAP_MS)
                raw.rollback()
            }
            try {
                raw.createStatement().use { it.execute(lockSql) }
                block()
            } finally {
                cap.cancel()
                raw.rollback()
            }
        }
    }

    private suspend fun <T> withPlanStateExclusive(block: suspend () -> T): T =
        withLocked("LOCK TABLE plan_state IN ACCESS EXCLUSIVE MODE", block)

    private suspend fun assertTimeoutProblem(response: HttpResponse, path: String) {
        assertEquals(HttpStatusCode.InternalServerError, response.status)
        assertTrue(response.headers[HttpHeaders.ContentType]?.startsWith("application/problem+json") == true)
        assertNull(response.headers[HttpHeaders.ETag], "a problem never carries a validator")
        val problem = response.body<ProblemDetail>()
        assertEquals(DATABASE_TIMEOUT_PROBLEM, problem.type)
        assertEquals("Internal Server Error", problem.title)
        assertEquals(500, problem.status)
        assertEquals("The database did not answer in time. Try again shortly.", problem.detail)
        assertEquals(path, problem.instance)
    }

    private fun workStreamCount(name: String): Int = PostgresTestSupport.connect().use { c ->
        c.prepareStatement("SELECT count(*) FROM work_streams WHERE name = ?").use { st ->
            st.setString(1, name)
            st.executeQuery().use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }
    }

    @Test
    fun `a view whose statement outruns the limit answers the typed problem, and the next read is a 200`() = testApplication {
        configureApp("postgres.statementTimeoutSeconds" to "1")
        startApplication()
        val admin = seededClient("stmt-view", UserRole.ADMIN)
        val response = withPlanStateExclusive { withTimeout(30_000) { admin.get("/api/v1/views/plan") } }
        assertTimeoutProblem(response, "/api/v1/views/plan")
        // The lock is gone: the very same read answers normally on the same pool (the cancelled connection is intact).
        assertEquals(HttpStatusCode.OK, admin.get("/api/v1/views/plan").status)
    }

    @Test
    fun `a save cut by the limit answers the same problem and has written, bumped and audited nothing`() = testApplication {
        configureApp("postgres.statementTimeoutSeconds" to "1")
        startApplication()
        val admin = seededClient("stmt-save", UserRole.ADMIN)
        val owner = TestPeople.seed(planName("stmt-owner"))
        val name = planName("stmt-ws")
        val body = WorkStreamCreateRequest(name, null, owner, "2026-01-01")
        val before = TestPlan.revision()
        withAuditCapture { capture ->
            val response = withLocked("SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE") {
                withTimeout(30_000) { admin.postJson("/api/v1/work-streams", body) }
            }
            assertTimeoutProblem(response, "/api/v1/work-streams")
            assertEquals(0, workStreamCount(name), "the cut save left no row")
            assertEquals(before, TestPlan.revision(), "the cut save did not move the plan revision")
            assertTrue(capture.events.none { it.message.startsWith("work_stream.") }, "the cut save emitted no audit event")
            // With the lock gone the same request is a 201 on the same pool.
            assertEquals(HttpStatusCode.Created, admin.postJson("/api/v1/work-streams", body).status)
            assertNotNull(capture.awaitEvent { it.message == "work_stream.created" }, "the audit capture does see a create that succeeds")
            assertEquals(1, workStreamCount(name))
            assertEquals(before + 1, TestPlan.revision())
        }
    }

    @Test
    fun `a cancelled statement is ONE warning with the method and the path - no SQL, no stack, no error`() = testApplication {
        configureApp("postgres.statementTimeoutSeconds" to "1")
        startApplication()
        val admin = seededClient("stmt-log", UserRole.ADMIN)
        val capture = LogCapture(org.slf4j.Logger.ROOT_LOGGER_NAME)
        try {
            val response = withPlanStateExclusive { withTimeout(30_000) { admin.get("/api/v1/views/plan?probe=secret-value") } }
            assertEquals(HttpStatusCode.InternalServerError, response.status)
            val expected = "Statement cancelled by the database time limit while processing GET /api/v1/views/plan"
            val warnings = capture.events.filter { it.message.startsWith("Statement cancelled") }
            assertEquals(1, warnings.size, "exactly one line: ${warnings.map { it.message }}")
            val line = warnings.single()
            assertEquals(expected, line.formattedMessage, "the method and the path only, never the query string")
            assertEquals(ch.qos.logback.classic.Level.WARN, line.level)
            assertNull(line.throwableProxy, "no exception reaches the log")
            val everything = capture.events.joinToString("\n") { "${it.formattedMessage} ${it.throwableProxy?.message.orEmpty()}" }
            for (leak in listOf("SELECT", "plan_state", "secret-value")) {
                assertTrue(leak !in everything, "the log must not carry '$leak'")
            }
            assertTrue(
                capture.events.none { it.level == ch.qos.logback.classic.Level.ERROR && "Unhandled exception" in it.formattedMessage },
                "a cancelled statement is not an unhandled exception",
            )
        } finally {
            capture.detach()
        }
    }

    @Test
    fun `a transaction's own budget wins, and a zero budget of the sync readers means the pool's own limit`() = testApplication {
        configureApp("postgres.statementTimeoutSeconds" to "1")
        startApplication()
        val db = application.attributes[R2dbcDatabaseKey]
        suspend fun show(own: Int?) = suspendTransaction(db) {
            if (own != null) queryTimeout = own
            exec("SHOW statement_timeout") { row -> row.get(0, String::class.java) }?.toList()
        }
        assertEquals(listOf("1s"), show(null), "the pool's default")
        assertEquals(listOf("2s"), show(2), "a transaction that sets its own keeps it")
        assertEquals(listOf("1s"), show(null), "and a later transaction sees the default again (on whichever connection)")
        // An explicit 0 would switch the limit OFF for its transaction: why the two sync readers assign only a POSITIVE budget.
        assertEquals(listOf("0"), show(0))

        // The readers' default of 0 (no budget of their own) runs under the pool's 1 s: a locked table cancels them.
        suspend fun cancelled(block: suspend () -> Unit): Throwable? =
            runCatching { withTimeout(30_000) { block() } }.exceptionOrNull()
        val pollFailure = withLocked("LOCK TABLE jira_connections IN ACCESS EXCLUSIVE MODE") { cancelled { jiraPollRows(db, 0) } }
        assertNotNull(pollFailure, "pollRowsOf with no budget of its own must run under the pool's limit")
        assertTrue(pollFailure.isQueryCanceled(), "expected query_canceled, got $pollFailure")
        val runs = SyncRunService(db, maxRunMinutes = 10)
        val runsFailure = withLocked("LOCK TABLE sync_runs IN ACCESS EXCLUSIVE MODE") {
            cancelled { runs.recentRuns(SyncKind.JIRA, listOf(999_999u), queryTimeoutSeconds = 0) }
        }
        assertNotNull(runsFailure, "recentRuns with no budget of its own must run under the pool's limit")
        assertTrue(runsFailure.isQueryCanceled(), "expected query_canceled, got $runsFailure")
        // With the locks gone both read again.
        jiraPollRows(db, 0)
        runs.recentRuns(SyncKind.JIRA, listOf(999_999u))
    }

    @Test
    fun `a cancelled access-check read answers the typed 500, never a 401`() = testApplication {
        configureApp("postgres.statementTimeoutSeconds" to "1")
        startApplication()
        val client = seededClient("stmt-auth")
        val capture = LogCapture(org.slf4j.Logger.ROOT_LOGGER_NAME)
        try {
            // The per-request account check (plugins/Security.kt) reads `users`; locked, it is cancelled before any route runs.
            val response = withLocked("LOCK TABLE users IN ACCESS EXCLUSIVE MODE") { withTimeout(30_000) { client.get("/api/v1/teams") } }
            assertTimeoutProblem(response, "/api/v1/teams")
            assertEquals(
                1, capture.events.count { it.message.startsWith("Statement cancelled by the database time limit") },
                "one warning",
            )
        } finally {
            capture.detach()
        }
        assertEquals(HttpStatusCode.OK, client.get("/api/v1/teams").status)
    }

    @Test
    fun `another failure is not relabelled, and a cancellation anywhere in the cause chain is`() = testApplication {
        configureApp("postgres.statementTimeoutSeconds" to "1")
        application {
            routing {
                get("/zz-statement-timeout/other") { throw R2dbcNonTransientResourceException("boom", "53300") }
                get("/zz-statement-timeout/wrapped") {
                    throw IllegalStateException("wrapped", R2dbcNonTransientResourceException("canceling statement", "57014"))
                }
            }
        }
        startApplication()
        // The default client on purpose: the probes are not in the spec, and the conformance plugin would rightly flag them.
        val other = client.get("/zz-statement-timeout/other")
        assertEquals(HttpStatusCode.InternalServerError, other.status)
        val otherProblem = kotlinx.serialization.json.Json.decodeFromString(ProblemDetail.serializer(), other.bodyAsText())
        assertEquals("about:blank", otherProblem.type)
        assertEquals("An unexpected error occurred", otherProblem.detail)

        val wrapped = client.get("/zz-statement-timeout/wrapped")
        assertEquals(HttpStatusCode.InternalServerError, wrapped.status)
        val wrappedProblem = kotlinx.serialization.json.Json.decodeFromString(ProblemDetail.serializer(), wrapped.bodyAsText())
        assertEquals(DATABASE_TIMEOUT_PROBLEM, wrappedProblem.type)
        assertEquals("The database did not answer in time. Try again shortly.", wrappedProblem.detail)
    }

    private companion object {
        /** Well above the 1 s limit of these tests, well below the 60 s of the harness's default and `testApplication`'s own hard limit. */
        const val LOCK_CAP_MS = 20_000L
    }
}
