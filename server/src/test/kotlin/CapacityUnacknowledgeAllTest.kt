package ch.nokillswit

import ch.nokillswit.sync.STALE_DEVIATIONS_PROBLEM
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `POST /integrations/flow/team-bindings/{id}/unacknowledge-all` (1.11): the rows the caller names, withdrawn in one all-or-nothing
 * write, over the same scripted Flow as [CapacityAcknowledgeAllTest] ([capAckWorld], day two: sprint 2 a WARNING, sprint 3 an INFO,
 * Billing gone). The caller matrix, the 404 -> 403 -> 400 order, the delete, the 409 that deletes nothing and the audits. The lock
 * races are `CapacityAcknowledgeRaceTest`'s, the 401 `AnonymousAccessTest`'s.
 */
class CapacityUnacknowledgeAllTest {
    private val mirrors = mutableListOf<ScriptedFlowMirror>()

    @AfterTest
    fun cleanUp() {
        mirrors.forEach { it.cleanUp() }
        mirrors.clear()
        removeFlowFixtureRows(CAPACK_PREFIX)
    }

    private suspend fun ApplicationTestBuilder.dayTwo(label: String): CapAckWorld = capAckWorld(label, mirrors).also { it.refresh() }

    private fun keyValues(event: ch.qos.logback.classic.spi.ILoggingEvent, vararg expected: Pair<String, Any>) {
        for ((key, value) in expected) assertTrue(event.hasKeyValue(key, value), "$key=$value in ${event.keyValuePairs}")
    }

    private suspend fun assertStale(what: String, response: HttpResponse) {
        assertEquals(HttpStatusCode.Conflict, response.status, what)
        assertEquals(STALE_DEVIATIONS_PROBLEM, response.jbProblem().type, what)
    }

    /** Acknowledges sprints 2 and 3 (as the admin), answering their fingerprints. */
    private suspend fun CapAckWorld.acknowledgeBoth(): Pair<String, String> {
        val admin = w.admin.client
        val warning = admin.rowOf(2).fingerprint
        val info = admin.rowOf(3).fingerprint
        assertEquals(HttpStatusCode.OK, admin.capAckAll(bindingId, 2L to warning, 3L to info).status)
        return warning to info
    }

    @Test
    fun `the team's manager and ADMIN withdraw every named row, every other caller is 403 and nothing is deleted`() = testApplication {
        val world = dayTwo("capunack1")
        with(world) {
            val admin = w.admin.client
            acknowledgeBoth()
            val others = listOf(
                "the other team's manager" to w.requireTeams().otherManager,
                "a project owner" to w.projectOwner,
                "a roadmap editor" to w.editor,
                "a stranger" to w.stranger,
                "a person-less login" to w.personless,
            )
            for ((who, caller) in others) assertEquals(HttpStatusCode.Forbidden, caller.client.capUnackAll(bindingId, 2, 3).status, who)
            assertEquals(2, capAckStored(bindingId))

            assertEquals(HttpStatusCode.NoContent, manager.client.capUnackAll(bindingId, 3, 2).status)
            assertEquals(0, capAckStored(bindingId))
            assertNull(admin.rowOf(2).acknowledgement, "the row is open again")
            assertNull(admin.rowOf(3).acknowledgement)

            acknowledgeBoth()
            assertEquals(HttpStatusCode.NoContent, admin.capUnackAll(bindingId, 2, 3).status)
            assertEquals(0, capAckStored(bindingId))
        }
    }

    @Test
    fun `an unknown, unlinked or dead-team binding is 404 for EVERY caller - before the guard and before the body`() = testApplication {
        val world = dayTwo("capunack2")
        with(world) {
            val deadTeam = bindingId
            val unlinked = billingBindingId
            jbSql("UPDATE flow_team_bindings SET marked_as_deleted = TRUE WHERE id = ?", unlinked.toInt())
            jbSql("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", teamId.toInt())
            val callers = listOf(
                "admin" to w.admin, "manager" to manager, "other manager" to w.requireTeams().otherManager,
                "stranger" to w.stranger, "person-less" to w.personless,
            )
            for ((who, caller) in callers) {
                for ((what, id) in listOf("unknown" to 2_000_000_000u, "unlinked" to unlinked, "dead team" to deadTeam)) {
                    assertEquals(HttpStatusCode.NotFound, caller.client.capUnackAll(id, 2).status, "$who: $what")
                    assertEquals(HttpStatusCode.NotFound, caller.client.capUnackAllRaw(id, "{ not json").status, "$who: $what, malformed")
                }
            }
        }
    }

    @Test
    fun `a forbidden caller's malformed body stays 403 and the manager's is 400 - the guard comes first`() = testApplication {
        val world = dayTwo("capunack3")
        with(world) {
            fun item(sprint: String = "2") = """{"sprintId":$sprint}"""
            val tooMany = (1..2_001).joinToString(",") { item(it.toString()) }
            val bodies = listOf(
                "{ not json", "{}", """{"items":null}""", """{"items":[]}""", """{"items":"x"}""", """{"items":[{}]}""",
                """{"items":[${item("0")}]}""", """{"items":[${item("-1")}]}""", """{"items":[${item("\"two\"")}]}""",
                """{"items":[${item()},${item("3")},${item()}]}""", """{"items":[${item("null")},${item("null")}]}""",
                """{"items":[$tooMany]}""",
            )
            for (body in bodies) {
                val label = body.take(80)
                assertEquals(HttpStatusCode.Forbidden, w.stranger.client.capUnackAllRaw(bindingId, body).status, "stranger: $label")
                assertEquals(HttpStatusCode.BadRequest, manager.client.capUnackAllRaw(bindingId, body).status, "manager: $label")
            }
            val full = (1..2_000).joinToString(",") { item(it.toString()) }
            val atTheCap = manager.client.capUnackAllRaw(bindingId, """{"items":[$full]}""")
            assertStale("2,000 rows is within the cap and only then compared", atTheCap)
        }
    }

    @Test
    fun `only the named rows are withdrawn, the team's own row included, and a stale acknowledgement goes too`() = testApplication {
        val world = dayTwo("capunack4")
        with(world) {
            val admin = w.admin.client
            val (_, info) = acknowledgeBoth()
            assertEquals(HttpStatusCode.NoContent, manager.client.capUnackAll(bindingId, 2).status)
            assertNull(capAckRow(bindingId, 2))
            assertNotNull(capAckRow(bindingId, 3), "a row the request did not name stays acknowledged")
            assertEquals(true, admin.rowOf(3).acknowledgement?.current)

            // The figures move, so sprint 3's acknowledgement is stale (its row is listed and still stored): it is withdrawn all the same.
            jbSql("UPDATE team_capacity_periods SET md_per_week = 17 WHERE team_id = ? AND flow_sprint_id = 3", teamId.toInt())
            assertEquals(false, admin.rowOf(3).acknowledgement?.current)
            assertNotNull(capAckRow(bindingId, 3)?.takeIf { it.contains(info) })
            assertEquals(HttpStatusCode.NoContent, manager.client.capUnackAll(bindingId, 3).status)
            assertEquals(0, capAckStored(bindingId))

            // The team's own row (null) is one row of its own binding and nobody else's.
            val billingManager = w.requireTeams().otherManager
            val gone = admin.rowOf(null, billingBindingId).fingerprint
            assertEquals(HttpStatusCode.OK, billingManager.client.capAckAll(billingBindingId, null to gone).status)
            assertEquals(HttpStatusCode.Forbidden, manager.client.capUnackAll(billingBindingId, null).status)
            assertEquals(HttpStatusCode.NoContent, billingManager.client.capUnackAll(billingBindingId, null).status)
            assertEquals(0, capAckStored(billingBindingId))
        }
    }

    @Test
    fun `a named row with no stored acknowledgement is 409 and NOTHING is deleted`() = testApplication {
        val world = dayTwo("capunack5")
        with(world) {
            val admin = w.admin.client
            val warning = admin.rowOf(2).fingerprint
            assertEquals(HttpStatusCode.OK, admin.capAck(bindingId, 2, warning).status)
            val kept = capAckRow(bindingId, 2)
            assertNotNull(kept)

            assertStale("sprint 3 was never acknowledged", manager.client.capUnackAll(bindingId, 2, 3))
            assertStale("the team's own row was never acknowledged", manager.client.capUnackAll(bindingId, null, 2))
            assertStale("an unknown sprint", manager.client.capUnackAll(bindingId, 999, 2))
            assertEquals(kept, capAckRow(bindingId, 2), "no named row was deleted")

            // A row that is stored but no longer listed (a plan edit brought it in line; no run, no acknowledge yet) is still withdrawn.
            val info = admin.rowOf(3).fingerprint
            assertEquals(HttpStatusCode.OK, admin.capAck(bindingId, 3, info).status)
            jbSql("UPDATE team_capacity_periods SET md_per_week = 24 WHERE team_id = ? AND flow_sprint_id = 3", teamId.toInt())
            assertEquals(HttpStatusCode.NoContent, manager.client.capUnackAll(bindingId, 3).status)
            assertNull(capAckRow(bindingId, 3))

            // Twice: the second finds nothing, the list changed since it was read.
            assertEquals(HttpStatusCode.NoContent, manager.client.capUnackAll(bindingId, 2).status)
            assertStale("already withdrawn", manager.client.capUnackAll(bindingId, 2))

            // A binding on a connection that never mirrored a document has none.
            val unmirrored = ScriptedFlowMirror(CAPACK_PREFIX).connect().also { mirrors += it }
            val team = unmirrored.harness.bind(CAPACK_PREFIX, unmirrored.connectionId, 1, "Never mirrored")
            val neverMirrored = jbScalar("SELECT id FROM flow_team_bindings WHERE team_id = ?", team.toInt()) { it.getInt(1) }.toUInt()
            assertStale("a binding with nothing acknowledged", admin.capUnackAll(neverMirrored, 2))
        }
    }

    @Test
    fun `the audits - one batch line, the single withdrawal's line per row, and none for a refusal`() = testApplication {
        val world = dayTwo("capunack6")
        with(world) {
            val admin = w.admin.client
            val (warning, info) = acknowledgeBoth()
            val gone = admin.rowOf(null, billingBindingId).fingerprint
            val billingManager = w.requireTeams().otherManager
            assertEquals(HttpStatusCode.OK, billingManager.client.capAckAll(billingBindingId, null to gone).status)
            withAuditCapture { audit ->
                assertEquals(HttpStatusCode.Forbidden, w.stranger.client.capUnackAll(bindingId, 2).status)
                assertEquals(HttpStatusCode.BadRequest, manager.client.capUnackAllRaw(bindingId, "{}").status)
                assertEquals(HttpStatusCode.NotFound, manager.client.capUnackAll(2_000_000_000u, 2).status)
                assertEquals(HttpStatusCode.Conflict, manager.client.capUnackAll(bindingId, 2, 3, 4).status)
                assertTrue(audit.events.none { it.message.startsWith("flow.capacity_") }, "a refusal audits nothing of its own")

                assertEquals(HttpStatusCode.NoContent, manager.client.capUnackAll(bindingId, 3, 2).status)
                val relevant = audit.events.filter { it.message.startsWith("flow.capacity_") }
                assertEquals(
                    listOf("flow.capacity_deviations_unacknowledged") + List(2) { "flow.capacity_deviation_unacknowledged" },
                    relevant.map { it.message }, "the batch line, then one per row in the request's order; no cleanup line",
                )
                val common = arrayOf(
                    "byUserId" to manager.userId.toLong(), "bindingId" to bindingId.toLong(),
                    "connectionId" to mirror.connectionId.toLong(), "teamId" to teamId.toLong(), "flowTeamId" to 1L,
                )
                keyValues(relevant[0], *common, "count" to 2, "sprintIds" to "3,2")
                keyValues(relevant[1], *common, "sprintId" to 3L, "fingerprint" to info)
                keyValues(relevant[2], *common, "sprintId" to 2L, "fingerprint" to warning)

                assertEquals(HttpStatusCode.NoContent, billingManager.client.capUnackAll(billingBindingId, null).status)
                val batch = audit.events.last { it.message == "flow.capacity_deviations_unacknowledged" }
                keyValues(batch, "count" to 1, "sprintIds" to "none")
                keyValues(
                    audit.events.last { it.message == "flow.capacity_deviation_unacknowledged" },
                    "bindingId" to billingBindingId.toLong(), "sprintId" to "none", "fingerprint" to gone,
                )
            }
        }
    }
}
