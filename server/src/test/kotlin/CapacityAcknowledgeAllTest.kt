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
 * `POST /integrations/flow/team-bindings/{id}/acknowledge-all` (1.10): every row the caller names, in one all-or-nothing write, over the
 * same scripted Flow as [CapacityAcknowledgeTest] ([capAckWorld], day two: sprint 2 a WARNING, sprint 3 an INFO, Billing gone). The
 * caller matrix, the 404 -> 403 -> 400 order, the stamp, the 409 that stores nothing, the prune that applies once and the audits. The
 * lock races are `CapacityAcknowledgeRaceTest`'s, the 401 `AnonymousAccessTest`'s.
 */
class CapacityAcknowledgeAllTest {
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

    @Test
    fun `the team's manager and ADMIN acknowledge every named row, every other caller is 403 and nothing is stored`() = testApplication {
        val world = dayTwo("capackall1")
        with(world) {
            val admin = w.admin.client
            val warning = admin.rowOf(2).fingerprint
            val info = admin.rowOf(3).fingerprint
            val others = listOf(
                "the other team's manager" to w.requireTeams().otherManager,
                "a project owner" to w.projectOwner,
                "a roadmap editor" to w.editor,
                "a stranger" to w.stranger,
                "a person-less login" to w.personless,
            )
            for ((who, caller) in others) {
                assertEquals(HttpStatusCode.Forbidden, caller.client.capAckAll(bindingId, 2L to warning, 3L to info).status, who)
            }
            assertEquals(0, capAckStored(bindingId))

            val byAdmin = admin.capAckAll(bindingId, 2L to warning, 3L to info).capBatch()
            assertEquals(listOf<Long?>(2, 3), byAdmin.acknowledged.map { it.sprintId }, "the request's order")
            assertTrue(byAdmin.acknowledged.all { it.bindingId == bindingId })
            assertEquals(listOf(warning, info), byAdmin.acknowledged.map { it.fingerprint })
            assertNotNull(byAdmin.acknowledged.first().acknowledgedBy)

            val byManager = manager.client.capAckAll(bindingId, 3L to info, 2L to warning).capBatch()
            assertEquals(listOf<Long?>(3, 2), byManager.acknowledged.map { it.sprintId }, "the request's order, reversed")
            val personName = jbScalar("SELECT name FROM people WHERE id = ?", manager.personId!!.toInt()) { it.getString(1) }
            assertEquals(setOf(personName), byManager.acknowledged.mapTo(HashSet()) { it.acknowledgedBy })
            assertEquals(2, capAckStored(bindingId), "restamped, one row per (binding, sprint)")
        }
    }

    @Test
    fun `an unknown, unlinked or dead-team binding is 404 for EVERY caller - before the guard and before the body`() = testApplication {
        val world = dayTwo("capackall2")
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
                    assertEquals(HttpStatusCode.NotFound, caller.client.capAckAll(id, 2L to "0".repeat(64)).status, "$who: $what")
                    assertEquals(HttpStatusCode.NotFound, caller.client.capAckAllRaw(id, "{ not json").status, "$who: $what, malformed")
                }
            }
        }
    }

    @Test
    fun `a forbidden caller's malformed body stays 403 and the manager's is 400 - the guard comes first`() = testApplication {
        val world = dayTwo("capackall3")
        with(world) {
            val zeros = "0".repeat(64)
            fun item(sprint: String = "2", fp: String = zeros) = """{"sprintId":$sprint,"fingerprint":"$fp"}"""
            val tooMany = (1..2_001).joinToString(",") { item(it.toString()) }
            val bodies = listOf(
                "{ not json", "{}", """{"items":null}""", """{"items":[]}""", """{"items":"x"}""", """{"items":[{}]}""",
                """{"items":[{"fingerprint":"$zeros"}]}""", """{"items":[{"sprintId":2}]}""",
                """{"items":[${item("0")}]}""", """{"items":[${item("-1")}]}""", """{"items":[${item("\"two\"")}]}""",
                """{"items":[${item(fp = "abc")}]}""", """{"items":[${item(fp = "A".repeat(64))}]}""",
                """{"items":[${item(fp = "0".repeat(65))}]}""",
                """{"items":[${item()},${item("3")},${item()}]}""", """{"items":[${item("null")},${item("null")}]}""",
                """{"items":[$tooMany]}""",
            )
            for (body in bodies) {
                val label = body.take(80)
                assertEquals(HttpStatusCode.Forbidden, w.stranger.client.capAckAllRaw(bindingId, body).status, "stranger: $label")
                assertEquals(HttpStatusCode.BadRequest, manager.client.capAckAllRaw(bindingId, body).status, "manager: $label")
            }
            val full = (1..2_000).joinToString(",") { item(it.toString()) }
            val atTheCap = manager.client.capAckAllRaw(bindingId, """{"items":[$full]}""")
            assertStale("2,000 rows is within the cap and only then compared", atTheCap)
            assertEquals(0, capAckStored(bindingId))
        }
    }

    @Test
    fun `every named row gets one time and one login, an unnamed open row stays open, a known row is restamped`() = testApplication {
        val world = dayTwo("capackall4")
        with(world) {
            val admin = w.admin.client
            val warning = admin.rowOf(2).fingerprint
            val info = admin.rowOf(3).fingerprint

            val first = manager.client.capAckAll(bindingId, 2L to warning).capBatch().acknowledged.single()
            assertEquals("2|$warning|${manager.userId}|${first.acknowledgedAt}", capAckRow(bindingId, 2))
            assertNull(capAckRow(bindingId, 3), "the row the request did not name stays open")
            assertNull(admin.rowOf(3).acknowledgement)
            assertEquals(true, admin.rowOf(2).acknowledgement?.current)

            val both = admin.capAckAll(bindingId, 2L to warning, 3L to info).capBatch().acknowledged
            assertEquals(1, both.map { it.acknowledgedAt }.distinct().size, "one stamp for the whole batch")
            assertTrue(both.first().acknowledgedAt >= first.acknowledgedAt)
            for (row in both) {
                val stored = "${row.sprintId}|${row.fingerprint}|${w.admin.userId}|${row.acknowledgedAt}"
                assertEquals(stored, capAckRow(bindingId, row.sprintId))
            }
            assertEquals(2, capAckStored(bindingId))
            assertEquals(listOf(true, true), listOf(2L, 3L).map { admin.rowOf(it).acknowledgement?.current })

            // The team's own row is one row, however often it is named.
            val billingManager = w.requireTeams().otherManager
            val gone = admin.rowOf(null, billingBindingId).fingerprint
            val again = (1..2).map { billingManager.client.capAckAll(billingBindingId, null to gone).capBatch().acknowledged.single() }
            assertNull(again.first().sprintId)
            assertEquals(1, capAckStored(billingBindingId))
            assertEquals("-|$gone|${billingManager.userId}|${again.last().acknowledgedAt}", capAckRow(billingBindingId, null))
        }
    }

    @Test
    fun `one wrong, stale or unlisted row among several is 409 and NOTHING is stored or changed`() = testApplication {
        val world = dayTwo("capackall5")
        with(world) {
            val admin = w.admin.client
            val warning = admin.rowOf(2).fingerprint
            val info = admin.rowOf(3).fingerprint
            val before = admin.capAck(bindingId, 3, info).capAcknowledgement()
            val kept = capAckRow(bindingId, 3)
            assertEquals("3|$info|${w.admin.userId}|${before.acknowledgedAt}", kept)

            assertStale("a wrong fingerprint", manager.client.capAckAll(bindingId, 2L to warning, 3L to "0".repeat(64)))
            assertStale("sprint 1 is in line", manager.client.capAckAll(bindingId, 2L to warning, 1L to warning))
            assertStale("an unknown sprint", manager.client.capAckAll(bindingId, 999L to warning, 2L to warning))
            assertStale("the team is not gone", manager.client.capAckAll(bindingId, 2L to warning, null to warning))
            assertStale("sprint 3's fingerprint sent for sprint 2", manager.client.capAckAll(bindingId, 2L to info, 3L to info))
            assertNull(capAckRow(bindingId, 2), "no named row was stored")
            assertEquals(kept, capAckRow(bindingId, 3), "and a stored one was not restamped")

            // The reading goes stale between the read and the write: a figure moves in the plan.
            jbSql("UPDATE team_capacity_periods SET md_per_week = 17 WHERE team_id = ? AND flow_sprint_id = 2", teamId.toInt())
            assertStale("the day-before fingerprint", manager.client.capAckAll(bindingId, 2L to warning, 3L to info))
            assertEquals(1, capAckStored(bindingId))
            val moved = admin.rowOf(2).fingerprint
            assertEquals(HttpStatusCode.OK, manager.client.capAckAll(bindingId, 2L to moved, 3L to info).status)
            assertEquals(2, capAckStored(bindingId))

            // A binding on a connection that never mirrored a document has no rows.
            val unmirrored = ScriptedFlowMirror(CAPACK_PREFIX).connect().also { mirrors += it }
            val team = unmirrored.harness.bind(CAPACK_PREFIX, unmirrored.connectionId, 1, "Never mirrored")
            val neverMirrored = jbScalar("SELECT id FROM flow_team_bindings WHERE team_id = ?", team.toInt()) { it.getInt(1) }.toUInt()
            assertStale("a connection that never mirrored a document", admin.capAckAll(neverMirrored, 2L to warning))
        }
    }

    @Test
    fun `the acknowledge's cleanup applies once - an unlisted stored row goes, and the cleared event names it`() = testApplication {
        val world = dayTwo("capackall6")
        with(world) {
            val admin = w.admin.client
            val warning = admin.rowOf(2).fingerprint
            val info = admin.rowOf(3).fingerprint
            assertEquals(HttpStatusCode.OK, admin.capAck(bindingId, 3, info).status)
            // Sprint 3 is brought in line by a plan edit (no run, no acknowledge): its row is still stored - the residual of 1.10 D6.
            // (Flow's 48 over the two weeks is 24 a week.)
            jbSql("UPDATE team_capacity_periods SET md_per_week = 24 WHERE team_id = ? AND flow_sprint_id = 3", teamId.toInt())
            assertEquals(listOf(2L), admin.rowsOf().map { it.detail.sprintId })
            assertEquals(1, capAckStored(bindingId))

            withAuditCapture { audit ->
                assertEquals(HttpStatusCode.OK, manager.client.capAckAll(bindingId, 2L to warning).status)
                val cleared = audit.events.single { it.message == "flow.capacity_acknowledgements_cleared" }
                keyValues(
                    cleared,
                    "byUserId" to manager.userId.toLong(), "bindingId" to bindingId.toLong(),
                    "connectionId" to mirror.connectionId.toLong(), "count" to 1, "sprintIds" to "3", "via" to "acknowledge",
                )
            }
            assertNull(capAckRow(bindingId, 3), "sprint 3 left the list, so its acknowledgement went")
            assertNotNull(capAckRow(bindingId, 2))
        }
    }

    @Test
    fun `a 409 batch leaves an unlisted stored row in place and audits no cleanup`() = testApplication {
        val world = dayTwo("capackall8")
        with(world) {
            val admin = w.admin.client
            val info = admin.rowOf(3).fingerprint
            assertEquals(HttpStatusCode.OK, admin.capAck(bindingId, 3, info).status)
            // Sprint 3 is in line by a plan edit (no run, no acknowledge): its row is still stored, and a successful write would prune it.
            jbSql("UPDATE team_capacity_periods SET md_per_week = 24 WHERE team_id = ? AND flow_sprint_id = 3", teamId.toInt())
            val stored = capAckRow(bindingId, 3)
            assertNotNull(stored)
            withAuditCapture { audit ->
                assertStale("a wrong fingerprint", manager.client.capAckAll(bindingId, 2L to "0".repeat(64)))
                assertEquals(stored, capAckRow(bindingId, 3), "the prunable row stays: a refused batch rolls everything back")
                assertNull(capAckRow(bindingId, 2))
                assertTrue(audit.events.none { it.message.startsWith("flow.capacity_") }, "no cleanup and no acknowledge line")
            }
        }
    }

    @Test
    fun `the audits - one batch line, the single write's line per row, the cleanup's line, and none for a refusal`() = testApplication {
        val world = dayTwo("capackall7")
        with(world) {
            val admin = w.admin.client
            val warning = admin.rowOf(2).fingerprint
            val info = admin.rowOf(3).fingerprint
            val gone = admin.rowOf(null, billingBindingId).fingerprint
            withAuditCapture { audit ->
                assertEquals(HttpStatusCode.Forbidden, w.stranger.client.capAckAll(bindingId, 2L to warning).status)
                assertEquals(HttpStatusCode.BadRequest, manager.client.capAckAllRaw(bindingId, "{}").status)
                assertEquals(HttpStatusCode.NotFound, manager.client.capAckAll(2_000_000_000u, 2L to warning).status)
                assertEquals(HttpStatusCode.Conflict, manager.client.capAckAll(bindingId, 2L to warning, 3L to "0".repeat(64)).status)
                assertTrue(audit.events.none { it.message.startsWith("flow.capacity_") }, "a refusal audits nothing of its own")

                assertEquals(HttpStatusCode.OK, manager.client.capAckAll(bindingId, 3L to info, 2L to warning).status)
                val relevant = audit.events.filter { it.message.startsWith("flow.capacity_") }
                assertEquals(
                    listOf("flow.capacity_deviations_acknowledged") + List(2) { "flow.capacity_deviation_acknowledged" },
                    relevant.map { it.message }, "the batch line, then one per row in the request's order; nothing was pruned",
                )
                val common = arrayOf(
                    "byUserId" to manager.userId.toLong(), "bindingId" to bindingId.toLong(),
                    "connectionId" to mirror.connectionId.toLong(), "teamId" to teamId.toLong(), "flowTeamId" to 1L,
                )
                keyValues(relevant[0], *common, "count" to 2, "sprintIds" to "3,2")
                keyValues(relevant[1], *common, "sprintId" to 3L, "kind" to "CAPACITY_DIFFERS", "severity" to "INFO", "fingerprint" to info)
                keyValues(
                    relevant[2], *common, "sprintId" to 2L, "kind" to "CAPACITY_DIFFERS", "severity" to "WARNING", "fingerprint" to warning,
                )

                val billingManager = w.requireTeams().otherManager
                assertEquals(HttpStatusCode.OK, billingManager.client.capAckAll(billingBindingId, null to gone).status)
                keyValues(audit.events.last { it.message == "flow.capacity_deviations_acknowledged" }, "count" to 1, "sprintIds" to "none")
                keyValues(
                    audit.events.last { it.message == "flow.capacity_deviation_acknowledged" },
                    "bindingId" to billingBindingId.toLong(), "sprintId" to "none", "kind" to "TEAM_GONE", "severity" to "WARNING",
                )
            }
        }
    }
}
