package ch.nokillswit

import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.ScheduleProposalRequest
import ch.nokillswit.planning.TeamView
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * `GET /views/team/{id}` and the Flow capacity flag (1.9): the header's `team.flags` and the weeks strip's `weeks[].flowCapacity` over
 * `CapacityAcknowledgeSupport`'s scripted world. On day two the team's sprint 2 (WARNING, 2049-03-15..03-26) and sprint 3 (INFO,
 * 2049-03-29..04-09) are open; a milestone scheduled 2049-03-08..04-09 gives the view the five weeks Monday 03-08, 03-15, 03-22, 03-29
 * and 04-05. The source's own rules are `FlowFlagSourceTest`'s.
 */
class TeamViewFlowFlagTest {
    private val mirrors = mutableListOf<ScriptedFlowMirror>()

    @AfterTest
    fun cleanUp() {
        mirrors.forEach { it.cleanUp() }
        mirrors.clear()
        removeFlowFixtureRows(CAPACK_PREFIX)
    }

    private val weekStarts = listOf("2049-03-08", "2049-03-15", "2049-03-22", "2049-03-29", "2049-04-05")

    /** Day two, with a milestone of the team spanning every sprint week. */
    private suspend fun ApplicationTestBuilder.world(label: String): CapAckWorld = capAckWorld(label, mirrors).also {
        it.refresh()
        val id = TestPlan.milestone(it.w.projectId, it.teamId, planName("tvff"), 5.0)
        TestPlan.schedule(id, "2049-03-08", "2049-04-09")
    }

    private suspend fun HttpClient.rawView(teamId: UInt): String {
        val response = get("/api/v1/views/team/$teamId")
        assertEquals(HttpStatusCode.OK, response.status)
        return response.bodyAsText()
    }

    private suspend fun HttpClient.view(teamId: UInt): TeamView = get("/api/v1/views/team/$teamId").body()

    private fun TeamView.marks(): Map<String, FlagSeverity?> = weeks.associate { it.weekStart to it.flowCapacity }

    @Test
    fun `the header carries ONE Flow capacity flag and the weeks of the disputed sprints are marked`() = testApplication {
        val world = world("tvff1")
        with(world) {
            val view = w.stranger.client.view(teamId)
            val flag = view.team.flags.single()
            assertEquals(listOf(FlagKind.FLOW_CAPACITY, FlagSeverity.WARNING, 2), listOf(flag.kind, flag.severity, flag.count))
            assertEquals(weekStarts, view.weeks.map { it.weekStart })
            assertEquals(
                mapOf(
                    "2049-03-08" to null,
                    "2049-03-15" to FlagSeverity.WARNING,
                    "2049-03-22" to FlagSeverity.WARNING,
                    "2049-03-29" to FlagSeverity.INFO,
                    "2049-04-05" to FlagSeverity.INFO,
                ),
                view.marks(),
            )
            // An unmarked week carries no member at all.
            val weeks = Json.parseToJsonElement(w.stranger.client.rawView(teamId)).jsonObject.getValue("weeks").jsonArray
            assertFalse(weeks[0].jsonObject.containsKey("flowCapacity"))
            assertEquals("WARNING", weeks[1].jsonObject.getValue("flowCapacity").toString().trim('"'))
        }
    }

    @Test
    fun `acknowledging a row silences its flag and weeks, acknowledging both clears the header and the strip`() = testApplication {
        val world = world("tvff2")
        with(world) {
            manager.client.capAck(bindingId, 2, w.admin.client.rowOf(2).fingerprint).capAcknowledgement()
            val afterOne = w.admin.client.view(teamId)
            assertEquals(listOf(FlagSeverity.INFO, 1), afterOne.team.flags.single().let { listOf(it.severity, it.count) })
            assertEquals(listOf(null, null, null, FlagSeverity.INFO, FlagSeverity.INFO), afterOne.weeks.map { it.flowCapacity })

            manager.client.capAck(bindingId, 3, w.admin.client.rowOf(3).fingerprint).capAcknowledgement()
            val afterBoth = w.admin.client.view(teamId)
            assertEquals(emptyList(), afterBoth.team.flags)
            assertTrue(afterBoth.weeks.all { it.flowCapacity == null })
            assertFalse(w.admin.client.rawView(teamId).contains("flowCapacity"))

            // A figure that moves after the acknowledgement reopens the sprint: the header and its weeks flag again.
            jbSql("UPDATE team_capacity_periods SET md_per_week = 17 WHERE team_id = ? AND flow_sprint_id = 2", teamId.toInt())
            val reopened = w.admin.client.view(teamId)
            assertEquals(1, reopened.team.flags.single().count)
            assertEquals(listOf(null, FlagSeverity.WARNING, FlagSeverity.WARNING, null, null), reopened.weeks.map { it.flowCapacity })
        }
    }

    @Test
    fun `a disabled connection and an unlinked team answer no flag, no marked week and no error`() = testApplication {
        val world = world("tvff3")
        with(world) {
            jbSql("UPDATE flow_connections SET enabled = FALSE WHERE id = ?", mirror.connectionId.toInt())
            val disabled = w.admin.client.view(teamId)
            assertEquals(emptyList(), disabled.team.flags)
            assertTrue(disabled.weeks.isNotEmpty() && disabled.weeks.all { it.flowCapacity == null })

            val unlinked = TestTeams.seed(planName("tvff-unlinked"))
            val view = w.admin.client.view(unlinked)
            assertEquals(emptyList(), view.team.flags)
            assertFalse(w.admin.client.rawView(unlinked).contains("flowCapacity"))
        }
    }

    @Test
    fun `the other team's gone Flow team flags its header and marks no week`() = testApplication {
        val world = world("tvff4")
        with(world) {
            val other = w.requireTeams().otherTeamId
            val id = TestPlan.milestone(w.projectId, other, planName("tvff-other"), 3.0)
            TestPlan.schedule(id, "2049-03-15", "2049-03-19")
            val view = w.admin.client.view(other)
            assertEquals(listOf(FlagSeverity.WARNING, 1), view.team.flags.single().let { listOf(it.severity, it.count) })
            assertTrue(view.weeks.isNotEmpty() && view.weeks.all { it.flowCapacity == null })
        }
    }

    @Test
    fun `an open row on a team with nothing scheduled flags the header and has no weeks to mark`() = testApplication {
        val world = capAckWorld("tvff6", mirrors).also { it.refresh() }
        with(world) {
            val view = w.admin.client.view(teamId)
            assertEquals(emptyList(), view.weeks)
            assertEquals(listOf(FlagSeverity.WARNING, 2), view.team.flags.single().let { listOf(it.severity, it.count) })
        }
    }

    @Test
    fun `baseline N carries the same team flags and marked weeks`() = testApplication {
        val world = world("tvff7")
        with(world) {
            val plain = w.admin.client.view(teamId)
            val baselineId = TestPlan.baseline(planName("tvff-bl"))
            val compared: TeamView = w.admin.client.get("/api/v1/views/team/$teamId?baseline=$baselineId").body()
            assertTrue(compared.baseline != null, "the baseline block is there")
            assertEquals(plain.team.flags, compared.team.flags)
            assertEquals(plain.marks(), compared.marks())
            assertEquals(1, compared.team.flags.size)
        }
    }

    @Test
    fun `a schedule proposal's weeks never carry the member`() = testApplication {
        val world = world("tvff5")
        with(world) {
            val response = manager.client.postJson("/api/v1/teams/$teamId/schedule-proposal", ScheduleProposalRequest("2049-03-01"))
            assertEquals(HttpStatusCode.OK, response.status)
            val text = response.bodyAsText()
            assertTrue(text.contains("\"weeks\""), "the proposal has its weeks")
            assertFalse(text.contains("flowCapacity"))
        }
    }
}
