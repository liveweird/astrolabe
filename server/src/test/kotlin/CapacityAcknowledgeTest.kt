package ch.nokillswit

import ch.nokillswit.flow.CapacityDeviationKind
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.sync.STALE_DEVIATIONS_PROBLEM
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `POST|DELETE /integrations/flow/team-bindings/{id}/acknowledge` (1.9): the per-sprint capacity acknowledge over a scripted Flow
 * ([capAckWorld]: three 2049 sprints imported on day one; on day two Flow says 30 against the plan's 36 for sprint 2 - a WARNING, +6.00 -
 * and 48 against 44 for sprint 3 - an INFO, -4.00 - and "Billing" is gone). The caller matrix, the 404 -> 403 -> 400 order, the 409s, the
 * `TEAM_GONE` row, the withdrawal and the audits. What the stored rows do to `GET /views/capacity-deviations` is 1.9's next step; here the
 * table is read straight. The lock races are `CapacityAcknowledgeRaceTest`'s, the fingerprint's vectors
 * `CapacityDeviationFingerprintTest`'s.
 */
class CapacityAcknowledgeTest {
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

    @Test
    fun `day two reads a WARNING for sprint 2, an INFO for sprint 3 and the gone team - each row has a fingerprint`() = testApplication {
        val world = dayTwo("capack0")
        with(world) {
            val rows = w.admin.client.rowsOf()
            assertEquals(listOf(2L, 3L), rows.map { it.detail.sprintId })
            assertEquals(listOf(DeviationSeverity.WARNING, DeviationSeverity.INFO), rows.map { it.severity })
            assertEquals(2, rows.map { it.fingerprint }.distinct().size)
            rows.forEach { assertTrue(Regex("^[0-9a-f]{64}$").matches(it.fingerprint)) }
            assertTrue(rows.all { it.acknowledgement == null }, "nothing is acknowledged yet")
            val gone = w.admin.client.rowsOf(billingBindingId).single()
            assertEquals(CapacityDeviationKind.TEAM_GONE, gone.kind)
            assertNull(gone.detail.sprintId)
        }
    }

    @Test
    fun `the team's manager and ADMIN acknowledge, every other caller is 403 and nothing is stored for them`() = testApplication {
        val world = dayTwo("capack1")
        with(world) {
            val admin = w.admin.client
            val warning = admin.rowOf(2)
            val info = admin.rowOf(3)
            val others = listOf(
                "the other team's manager" to w.requireTeams().otherManager,
                "a project owner" to w.projectOwner,
                "a roadmap editor" to w.editor,
                "a stranger" to w.stranger,
                "a person-less login" to w.personless,
            )
            for ((who, caller) in others) {
                assertEquals(HttpStatusCode.Forbidden, caller.client.capAck(bindingId, 2, warning.fingerprint).status, who)
                assertEquals(HttpStatusCode.Forbidden, caller.client.capUnack(bindingId, "?sprintId=2").status, "$who: DELETE")
            }
            assertEquals(0, capAckStored(bindingId))

            val byAdmin = admin.capAck(bindingId, 2, warning.fingerprint).capAcknowledgement()
            assertEquals(2L, byAdmin.sprintId)
            assertEquals(bindingId, byAdmin.bindingId)
            assertNotNull(byAdmin.acknowledgedBy, "a person-less login is named by its display name")

            val byManager = manager.client.capAck(bindingId, 3, info.fingerprint).capAcknowledgement()
            val personName = jbScalar("SELECT name FROM people WHERE id = ?", manager.personId!!.toInt()) { it.getString(1) }
            assertEquals(personName, byManager.acknowledgedBy, "the manager is named by their person")
            assertEquals(info.fingerprint, byManager.fingerprint)
            assertEquals(2, capAckStored(bindingId))
        }
    }

    @Test
    fun `an unknown, unlinked or dead-team binding is 404 for EVERY caller - before the guard and before the body`() = testApplication {
        val world = dayTwo("capack2")
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
                    assertEquals(HttpStatusCode.NotFound, caller.client.capAck(id, 2, "0".repeat(64)).status, "$who: $what")
                    assertEquals(HttpStatusCode.NotFound, caller.client.capAckRaw(id, "{ not json").status, "$who: $what, malformed")
                    assertEquals(HttpStatusCode.NotFound, caller.client.capUnack(id, "?sprintId=abc").status, "$who: $what, DELETE")
                }
            }
        }
    }

    @Test
    fun `a forbidden caller's malformed input stays 403 and the manager's is 400 - the guard comes first, sprintId is required`() =
        testApplication {
            val world = dayTwo("capack3")
            with(world) {
                val zeros = "0".repeat(64)
                val bodies = listOf(
                    "{ not json", "{}", """{"fingerprint":"$zeros"}""", """{"sprintId":2}""", """{"sprintId":0,"fingerprint":"$zeros"}""",
                    """{"sprintId":-1,"fingerprint":"$zeros"}""", """{"sprintId":"two","fingerprint":"$zeros"}""",
                    """{"sprintId":2,"fingerprint":"abc"}""", """{"sprintId":2,"fingerprint":"${"A".repeat(64)}"}""",
                    """{"sprintId":2,"fingerprint":"${"0".repeat(65)}"}""", """{"sprintId":null,"fingerprint":""}""",
                )
                for (body in bodies) {
                    assertEquals(HttpStatusCode.Forbidden, w.stranger.client.capAckRaw(bindingId, body).status, "stranger: $body")
                    assertEquals(HttpStatusCode.BadRequest, manager.client.capAckRaw(bindingId, body).status, "manager: $body")
                }
                for (query in listOf("?sprintId=abc", "?sprintId=1&sprintId=2", "?sprintId=0", "?sprintId=-3", "?sprintId=", "?sprintId")) {
                    assertEquals(HttpStatusCode.Forbidden, w.stranger.client.capUnack(bindingId, query).status, "stranger: $query")
                    assertEquals(HttpStatusCode.BadRequest, manager.client.capUnack(bindingId, query).status, "manager: $query")
                }
                assertEquals(0, capAckStored(bindingId))
            }
        }

    @Test
    fun `a stored acknowledgement is who, when and the row's fingerprint - again restamps, a rename in Flow changes nothing`() =
        testApplication {
            val world = dayTwo("capack4")
            with(world) {
                val admin = w.admin.client
                val seen = admin.rowOf(2)
                val first = manager.client.capAck(bindingId, 2, seen.fingerprint).capAcknowledgement()
                assertEquals("2|${seen.fingerprint}|${manager.userId}|${first.acknowledgedAt}", capAckRow(bindingId, 2))
                assertNull(capAckRow(bindingId, 3), "the other sprint stays open")

                val second = admin.capAck(bindingId, 2, seen.fingerprint).capAcknowledgement()
                assertEquals(1, capAckStored(bindingId), "one row per (binding, sprint)")
                assertTrue(second.acknowledgedAt >= first.acknowledgedAt)
                assertEquals("2|${seen.fingerprint}|${w.admin.userId}|${second.acknowledgedAt}", capAckRow(bindingId, 2), "restamped")

                refresh(s2Name = "S2 renamed in Flow")
                val renamed = admin.rowOf(2)
                assertEquals("S2 renamed in Flow", renamed.detail.sprintName)
                assertEquals(seen.fingerprint, renamed.fingerprint, "the name is not an input")
                val afterRename = manager.client.capAck(bindingId, 2, seen.fingerprint)
                assertEquals(HttpStatusCode.OK, afterRename.status, "the pre-rename reading is current")
            }
        }

    @Test
    fun `a wrong or stale fingerprint, a row that is not listed, a team that is not gone and an unmirrored connection are 409`() =
        testApplication {
            val world = dayTwo("capack5")
            with(world) {
                val admin = w.admin.client
                val seen = admin.rowOf(2)
                suspend fun assertStale(what: String, response: io.ktor.client.statement.HttpResponse) {
                    assertEquals(HttpStatusCode.Conflict, response.status, what)
                    assertEquals(STALE_DEVIATIONS_PROBLEM, response.jbProblem().type, what)
                }
                assertStale("a wrong fingerprint", manager.client.capAck(bindingId, 2, "0".repeat(64)))
                assertStale("sprint 1 is in line", manager.client.capAck(bindingId, 1, seen.fingerprint))
                assertStale("an unknown sprint", manager.client.capAck(bindingId, 999, seen.fingerprint))
                assertStale("the team is not gone", manager.client.capAck(bindingId, null, seen.fingerprint))
                val billingManager = w.requireTeams().otherManager.client
                assertStale("a sprint row on a gone team", billingManager.capAck(billingBindingId, 2, seen.fingerprint))

                // The reading goes stale: the plan's figure for sprint 2 moves (a capacity edit by the team).
                jbSql("UPDATE team_capacity_periods SET md_per_week = 17 WHERE team_id = ? AND flow_sprint_id = 2", teamId.toInt())
                val moved = admin.rowOf(2)
                assertNotEquals(seen.fingerprint, moved.fingerprint)
                assertStale("the day-before fingerprint", manager.client.capAck(bindingId, 2, seen.fingerprint))
                assertEquals(0, capAckStored(bindingId), "nothing was stored by a refused request")
                assertEquals(HttpStatusCode.OK, manager.client.capAck(bindingId, 2, moved.fingerprint).status)

                // A binding on a connection that never mirrored a document (the harness seeds, and its cleanUp removes, the team).
                val unmirrored = ScriptedFlowMirror(CAPACK_PREFIX).connect().also { mirrors += it }
                val team = unmirrored.harness.bind(CAPACK_PREFIX, unmirrored.connectionId, 1, "Never mirrored")
                val neverMirrored = jbScalar("SELECT id FROM flow_team_bindings WHERE team_id = ?", team.toInt()) { it.getInt(1) }.toUInt()
                assertStale("a connection that never mirrored a document", admin.capAck(neverMirrored, 2, seen.fingerprint))
                assertStale("... and its team row", admin.capAck(neverMirrored, null, seen.fingerprint))
            }
        }

    @Test
    fun `the gone team's own row is acknowledged with sprintId null, withdrawn without the parameter, and is one row`() = testApplication {
        val world = dayTwo("capack6")
        with(world) {
            val admin = w.admin.client
            val otherManager = w.requireTeams().otherManager
            val gone = admin.rowOf(null, billingBindingId)
            assertEquals(HttpStatusCode.Forbidden, manager.client.capAck(billingBindingId, null, gone.fingerprint).status)

            val first = otherManager.client.capAck(billingBindingId, null, gone.fingerprint).capAcknowledgement()
            assertNull(first.sprintId)
            assertEquals("-|${gone.fingerprint}|${otherManager.userId}|${first.acknowledgedAt}", capAckRow(billingBindingId, null))
            admin.capAck(billingBindingId, null, gone.fingerprint).capAcknowledgement()
            assertEquals(1, capAckStored(billingBindingId), "the second acknowledge restamped the team row (IS NOT DISTINCT FROM): one row")

            val blank = otherManager.client.capUnack(billingBindingId, "?sprintId=")
            assertEquals(HttpStatusCode.BadRequest, blank.status, "a present-but-blank sprintId is not 'absent'")
            assertEquals(1, capAckStored(billingBindingId), "so it never withdraws the team's own row")
            val noSprintRow = otherManager.client.capUnack(billingBindingId, "?sprintId=2")
            assertEquals(HttpStatusCode.NotFound, noSprintRow.status, "no sprint row stored")
            assertEquals(HttpStatusCode.NoContent, otherManager.client.capUnack(billingBindingId).status)
            assertEquals(0, capAckStored(billingBindingId))
            assertEquals(HttpStatusCode.NotFound, otherManager.client.capUnack(billingBindingId).status, "a second withdrawal")
        }
    }

    @Test
    fun `a withdrawal removes only its row, current or stale, and a second one is 404`() = testApplication {
        val world = dayTwo("capack7")
        with(world) {
            val admin = w.admin.client
            admin.capAck(bindingId, 2, admin.rowOf(2).fingerprint).capAcknowledgement()
            admin.capAck(bindingId, 3, admin.rowOf(3).fingerprint).capAcknowledgement()
            assertEquals(2, capAckStored(bindingId))

            assertEquals(HttpStatusCode.NoContent, manager.client.capUnack(bindingId, "?sprintId=2").status)
            assertNull(capAckRow(bindingId, 2))
            assertNotNull(capAckRow(bindingId, 3), "the other sprint's acknowledgement stays")
            assertEquals(HttpStatusCode.NotFound, manager.client.capUnack(bindingId, "?sprintId=2").status)
            assertEquals(HttpStatusCode.NotFound, manager.client.capUnack(bindingId).status, "the team row was never stored")

            jbSql("UPDATE team_capacity_periods SET md_per_week = 25 WHERE team_id = ? AND flow_sprint_id = 3", teamId.toInt())
            val stale = manager.client.capUnack(bindingId, "?sprintId=3")
            assertEquals(HttpStatusCode.NoContent, stale.status, "a stale acknowledgement is withdrawn too")
            assertEquals(0, capAckStored(bindingId))
        }
    }

    @Test
    fun `every committed write audits with its fields, and a refused request writes no capacity audit line`() = testApplication {
        val world = dayTwo("capack8")
        with(world) {
            val admin = w.admin.client
            val warning = admin.rowOf(2)
            val gone = admin.rowOf(null, billingBindingId)
            withAuditCapture { audit ->
                assertEquals(HttpStatusCode.Forbidden, w.stranger.client.capAck(bindingId, 2, warning.fingerprint).status)
                assertEquals(HttpStatusCode.BadRequest, manager.client.capAckRaw(bindingId, "{}").status)
                assertEquals(HttpStatusCode.NotFound, manager.client.capAck(2_000_000_000u, 2, warning.fingerprint).status)
                assertEquals(HttpStatusCode.Conflict, manager.client.capAck(bindingId, 2, "0".repeat(64)).status)
                assertEquals(HttpStatusCode.NotFound, manager.client.capUnack(bindingId, "?sprintId=2").status)
                assertTrue(audit.events.none { it.message.startsWith("flow.capacity_deviation") }, "a refusal audits nothing of its own")

                assertEquals(HttpStatusCode.OK, manager.client.capAck(bindingId, 2, warning.fingerprint).status)
                val acked = audit.events.single { it.message == "flow.capacity_deviation_acknowledged" }
                keyValues(
                    acked,
                    "byUserId" to manager.userId.toLong(), "bindingId" to bindingId.toLong(),
                    "connectionId" to mirror.connectionId.toLong(), "teamId" to teamId.toLong(), "flowTeamId" to 1L, "sprintId" to 2L,
                    "kind" to "CAPACITY_DIFFERS",
                    "severity" to "WARNING", "fingerprint" to warning.fingerprint,
                )
                assertEquals(HttpStatusCode.NoContent, manager.client.capUnack(bindingId, "?sprintId=2").status)
                keyValues(
                    audit.events.single { it.message == "flow.capacity_deviation_unacknowledged" },
                    "byUserId" to manager.userId.toLong(), "bindingId" to bindingId.toLong(), "teamId" to teamId.toLong(),
                    "sprintId" to 2L, "fingerprint" to warning.fingerprint,
                )

                val billingManager = w.requireTeams().otherManager.client
                assertEquals(HttpStatusCode.OK, billingManager.capAck(billingBindingId, null, gone.fingerprint).status)
                keyValues(
                    audit.events.last { it.message == "flow.capacity_deviation_acknowledged" },
                    "bindingId" to billingBindingId.toLong(), "sprintId" to "none", "kind" to "TEAM_GONE", "severity" to "WARNING",
                )
            }
        }
    }

    @Test
    fun `a team that returns to Flow loses its gone acknowledgement - its next disappearance is open again`() = testApplication {
        val world = dayTwo("capack9")
        with(world) {
            val admin = w.admin.client
            val billingManager = w.requireTeams().otherManager.client
            val sprint = admin.rowOf(2)
            assertEquals(HttpStatusCode.OK, manager.client.capAck(bindingId, 2, sprint.fingerprint).status)
            val gone = admin.rowOf(null, billingBindingId)
            assertEquals(HttpStatusCode.OK, billingManager.capAck(billingBindingId, null, gone.fingerprint).status)
            assertEquals(1, capAckStored(billingBindingId))

            refresh(dayTwo = false)
            assertEquals(0, capAckStored(billingBindingId), "Billing is in the document again: its gone acknowledgement is cleared")
            assertEquals(1, capAckStored(bindingId), "a sprint acknowledgement is not the mirror's business")
            assertTrue(admin.rowsOf(billingBindingId).isEmpty(), "no deviation while the team is present")

            refresh(dayTwo = true)
            val again = admin.rowOf(null, billingBindingId)
            assertNull(again.acknowledgement)
            assertNull(capAckRow(billingBindingId, null), "the new disappearance is open, nothing is stored for it")
            assertEquals(HttpStatusCode.OK, billingManager.capAck(billingBindingId, null, again.fingerprint).status, "and acknowledgeable")
        }
    }
}
