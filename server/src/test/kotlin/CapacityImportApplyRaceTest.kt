package ch.nokillswit

import ch.nokillswit.teams.CapacityPeriodRequest
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.jsonArray
import java.sql.Connection
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The capacity apply under the TEAM ROW LOCK (`TeamCapacityService.applyImport`), with a real non-admin manager (an ADMIN's guard returns
 * early). The `TeamCapacityLifecycleTest` barrier shape: a raw JDBC session holds the team row, the request passes its outer checks and
 * [awaitLockWait] says it reached the lock, the session changes the world and commits - and the held request must be judged against the
 * world as it then is. Then the apply against a concurrent capacity POST and against a second apply.
 */
class CapacityImportApplyRaceTest {
    private companion object {
        const val PREFIX = "capracel"
    }

    private val mirrors = mutableListOf<ScriptedFlowMirror>()

    @AfterTest
    fun cleanUp() {
        mirrors.forEach { it.cleanUp() }
        mirrors.clear()
        removeFlowFixtureRows(PREFIX)
    }

    private suspend fun mirrorOf(flowName: String, sprints: List<String>): ScriptedFlowMirror =
        ScriptedFlowMirror(PREFIX).connect().refresh(flowTeamDoc(1, flowName, sprints = sprints)).also { mirrors += it }

    /**
     * Holds [lockSql] (default: the team row `FOR NO KEY UPDATE`) on a raw session, starts [requests] one after the other (each is waited
     * to its wait on a lock before the next starts, so the queue order is the list order), runs [change] on the raw session, commits,
     * and answers them all.
     */
    private suspend fun <T> queuedAtTeamLock(
        teamId: UInt,
        requests: List<suspend () -> T>,
        lockSql: String = "SELECT id FROM teams WHERE id = $teamId FOR NO KEY UPDATE",
        change: (Connection) -> Unit,
    ): List<T> {
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.createStatement().use { it.executeQuery(lockSql).close() }
            try {
                return coroutineScope {
                    val pending = mutableListOf<Deferred<T>>()
                    for ((index, request) in requests.withIndex()) {
                        pending += async { request() }
                        awaitLockWait("FOR NO KEY UPDATE", waiters = index + 1)
                    }
                    assertTrue(pending.none { it.isCompleted }, "every request is held at the team lock")
                    change(raw)
                    raw.commit()
                    pending.awaitAll()
                }
            } finally {
                raw.rollback()
            }
        }
    }

    private fun sprints() = listOf(ciSprint(1, "S1", "2049-03-01", "2049-03-12", "40"), ciSprint(2, "S2", "2049-03-15", "2049-03-26", "36"))

    @Test
    fun `a manager cleared while the apply waits on the team row is refused 403 - nothing is written, no summary is audited`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("capr1", teams = true)
            val t = w.requireTeams()
            val m = mirrorOf(planName("capr-flow"), sprints())
            val binding = w.admin.client.fbBind(m.connectionId, 1, t.teamId).fbBinding()
            val stale = ciSeedFlowPeriod(t.teamId, "2049-07-05", "9.00", 99, "Gone sprint")
            val body = ciBodyOf(t.manager.client.ciPreviewOf(binding.id), removals = listOf(stale))
            val before = ciTeamRows(t.teamId)

            withAuditCapture { audit ->
                val response = queuedAtTeamLock(
                    t.teamId,
                    listOf { t.manager.client.ciApply(binding.id, body) },
                ) { it.exec("UPDATE teams SET manager_person_id = NULL WHERE id = ?", t.teamId.toInt()) }.single()

                assertEquals(HttpStatusCode.Forbidden, response.status, "the manager is judged under the lock, fresh, in the transaction")
                assertEquals(before, ciTeamRows(t.teamId), "nothing was created, updated or removed")
                assertTrue(audit.events.none { it.message.startsWith("team.capacity") }, "and nothing was audited")
            }
        }

    @Test
    fun `a team deleted while the apply waits is 404 and a binding unlinked meanwhile is 404 - nothing is written either way`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("capr2", teams = true)
            val t = w.requireTeams()
            val m = mirrorOf(planName("capr-flow"), sprints())
            val binding = w.admin.client.fbBind(m.connectionId, 1, t.teamId).fbBinding()
            val body = ciBodyOf(t.manager.client.ciPreviewOf(binding.id))

            // An unlink takes the BINDING row first (1.13.2: so does the apply, before the team row): the session holds that one.
            val unlinked = queuedAtTeamLock(
                t.teamId,
                listOf { t.manager.client.ciApply(binding.id, body) },
                lockSql = "SELECT id FROM flow_team_bindings WHERE id = ${binding.id} FOR NO KEY UPDATE",
            ) { it.exec("UPDATE flow_team_bindings SET marked_as_deleted = TRUE WHERE id = ?", binding.id.toInt()) }.single()
            assertEquals(HttpStatusCode.NotFound, unlinked.status, "the binding is re-read under the lock")
            assertEquals(emptyList(), ciTeamRows(t.teamId))

            val team = w.admin.client.fbBind(m.connectionId, 1, t.teamId).fbBinding()
            val deleted = queuedAtTeamLock(
                t.teamId,
                listOf { t.manager.client.ciApply(team.id, body) },
            ) { it.exec("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", t.teamId.toInt()) }.single()
            assertEquals(HttpStatusCode.NotFound, deleted.status, "the team row is locked and re-read active")
            assertEquals(emptyList(), ciTeamRows(t.teamId))
        }

    /** Sprint 1 starts on 2049-03-01: the date a manager's POST and the apply's CREATE both want. */
    private suspend fun ApplicationTestBuilder.queuedPostAndApply(postFirst: Boolean): Triple<HttpResponse, HttpResponse, UInt> {
        val w = planWorld(if (postFirst) "capr3a" else "capr3b", teams = true)
        val t = w.requireTeams()
        val m = mirrorOf(planName("capr-flow"), sprints())
        val binding = w.admin.client.fbBind(m.connectionId, 1, t.teamId).fbBinding()
        val body = ciBodyOf(t.manager.client.ciPreviewOf(binding.id))
        val post: suspend () -> HttpResponse =
            { t.manager.client.postJson("/api/v1/teams/${t.teamId}/capacity", CapacityPeriodRequest("2049-03-01", 33.0, 2)) }
        val apply: suspend () -> HttpResponse = { t.manager.client.ciApply(binding.id, body) }
        // Postgres queues the waiters of a row lock first come, first served; queuedAtTeamLock starts them one at a time.
        val (first, second) = queuedAtTeamLock(t.teamId, if (postFirst) listOf(post, apply) else listOf(apply, post)) { }
        return Triple(if (postFirst) first else second, if (postFirst) second else first, t.teamId)
    }

    @Test
    fun `an apply queued behind a manager's capacity POST on the same date sees the manual period and skips that sprint`() =
        testApplication {
            usePostgresTestcontainer()
            val (post, apply, teamId) = queuedPostAndApply(postFirst = true)

            assertEquals(HttpStatusCode.Created, post.status)
            assertEquals(HttpStatusCode.OK, apply.status)
            val result = apply.bodyAsText().fbObject()
            assertEquals(listOf("2"), result.ciRows("created").map { it.ciText("sprintId") }, "only sprint 2 is imported")
            assertEquals(listOf("1"), result.ciRows("skipped").map { it.ciText("sprintId") }, "sprint 1 is CHANGED: its date is MANUAL now")
            assertEquals(listOf("CHANGED"), result.ciRows("skipped").map { it.ciText("reason") })
            val onTheDate = ciTeamRows(teamId).filter { it.contains("=2049-03-01|") }
            assertEquals(listOf("2049-03-01|33.00|2|MANUAL|-|-|false"), onTheDate.map { it.substringAfter('=').substringBeforeLast('|') })
        }

    @Test
    fun `a manager's capacity POST queued behind an apply that took the date first is a 409 - the FLOW period stands`() = testApplication {
        usePostgresTestcontainer()
        val (post, apply, teamId) = queuedPostAndApply(postFirst = false)

        assertEquals(HttpStatusCode.OK, apply.status)
        assertEquals(2, apply.bodyAsText().fbObject().getValue("created").jsonArray.size)
        assertEquals(HttpStatusCode.Conflict, post.status, "the date is taken: the partial unique index")
        val onTheDate = ciTeamRows(teamId).filter { it.contains("=2049-03-01|") }
        assertEquals(listOf("2049-03-01|20.00|-|FLOW|1|S1|false"), onTheDate.map { it.substringAfter('=').substringBeforeLast('|') })
    }

    @Test
    fun `two applies of the same preview queued on the team row write once - the second finds every row CHANGED`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capr4", teams = true)
        val t = w.requireTeams()
        val m = mirrorOf(planName("capr-flow"), sprints())
        val binding = w.admin.client.fbBind(m.connectionId, 1, t.teamId).fbBinding()
        val body = ciBodyOf(t.manager.client.ciPreviewOf(binding.id))

        val (first, second) = queuedAtTeamLock<HttpResponse>(
            t.teamId,
            listOf({ t.manager.client.ciApply(binding.id, body) }, { w.admin.client.ciApply(binding.id, body) }),
        ) { }

        assertEquals(listOf(HttpStatusCode.OK, HttpStatusCode.OK), listOf(first.status, second.status))
        assertEquals(2, first.bodyAsText().fbObject().getValue("created").jsonArray.size)
        val replay = second.bodyAsText().fbObject()
        assertEquals(0, replay.getValue("created").jsonArray.size)
        assertEquals(listOf("1", "2"), replay.ciRows("skipped").map { it.ciText("sprintId") }.sorted())
        assertEquals(2, ciTeamRows(t.teamId).size, "two periods, written once")
    }
}
