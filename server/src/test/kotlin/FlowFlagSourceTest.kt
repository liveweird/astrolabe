package ch.nokillswit

import ch.nokillswit.flow.CapacityDeviation
import ch.nokillswit.flow.CapacityDeviationKind
import ch.nokillswit.flow.CapacityDeviationServiceKey
import ch.nokillswit.flow.FlowFlagSource
import ch.nokillswit.planning.ExternalFlagRequest
import ch.nokillswit.planning.ExternalFlags
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.FlaggedRange
import ch.nokillswit.planning.SNAPSHOT
import ch.nokillswit.planning.TeamExternal
import ch.nokillswit.planning.loadWorkingCalendar
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import java.time.LocalDate
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * The Flow side of the timeline views' flag seam (1.9), asked directly inside a read-only snapshot like the team view does, over
 * `CapacityAcknowledgeSupport`'s scripted world: on day two the team's sprint 2 is a WARNING (2049-03-15..03-26), its sprint 3 an INFO
 * (03-29..04-09) and the other team's Flow team is gone (a WARNING). The team view through HTTP is `TeamViewFlowFlagTest`.
 */
class FlowFlagSourceTest {
    private val mirrors = mutableListOf<ScriptedFlowMirror>()

    @AfterTest
    fun cleanUp() {
        mirrors.forEach { it.cleanUp() }
        mirrors.clear()
        removeFlowFixtureRows(CAPACK_PREFIX)
    }

    private suspend fun ApplicationTestBuilder.dayTwo(label: String): CapAckWorld = capAckWorld(label, mirrors).also { it.refresh() }

    /** The source asked inside a read-only snapshot, the way the team view asks it. */
    private suspend fun ApplicationTestBuilder.ask(teamId: UInt?, milestones: Collection<UInt> = emptyList()): ExternalFlags {
        val source = FlowFlagSource(application.attributes[CapacityDeviationServiceKey])
        return suspendTransaction(sharedDatabaseForTests(), SNAPSHOT, readOnly = true) {
            source.flagsInTransaction(ExternalFlagRequest(emptyList(), milestones, loadWorkingCalendar(), teamId))
        }
    }

    private fun range(from: String, to: String, severity: FlagSeverity) = FlaggedRange(LocalDate.parse(from), LocalDate.parse(to), severity)

    private val warningRange = range("2049-03-15", "2049-03-26", FlagSeverity.WARNING)
    private val infoRange = range("2049-03-29", "2049-04-09", FlagSeverity.INFO)

    @Test
    fun `two open rows raise ONE flag at the worst severity with count 2 and a range per row`() = testApplication {
        val world = dayTwo("flowflag1")
        with(world) {
            val team = ask(teamId).team(teamId)
            val flag = team.flags.single()
            assertEquals(FlagKind.FLOW_CAPACITY, flag.kind)
            assertEquals(FlagSeverity.WARNING, flag.severity)
            assertEquals(2, flag.count)
            assertEquals(listOf(null, null, null), listOf(flag.days, flag.teamId, flag.otherProjectId))
            assertEquals(null, flag.deviation)
            assertEquals(listOf(warningRange, infoRange), team.ranges)
        }
    }

    @Test
    fun `an acknowledged WARNING leaves an INFO flag with count 1 and one range, both acknowledged leave nothing`() = testApplication {
        val world = dayTwo("flowflag2")
        with(world) {
            manager.client.capAck(bindingId, 2, w.admin.client.rowOf(2).fingerprint).capAcknowledgement()
            val one = ask(teamId).team(teamId)
            assertEquals(listOf(FlagSeverity.INFO), one.flags.map { it.severity })
            assertEquals(1, one.flags.single().count)
            assertEquals(listOf(infoRange), one.ranges)

            manager.client.capAck(bindingId, 3, w.admin.client.rowOf(3).fingerprint).capAcknowledgement()
            val none = ask(teamId)
            assertSame(TeamExternal.NONE, none.team(teamId))
            assertTrue(none.teams.isEmpty(), "an all-acknowledged team is not in the answer")
        }
    }

    @Test
    fun `a stale acknowledgement flags again`() = testApplication {
        val world = dayTwo("flowflag3")
        with(world) {
            manager.client.capAck(bindingId, 2, w.admin.client.rowOf(2).fingerprint).capAcknowledgement()
            manager.client.capAck(bindingId, 3, w.admin.client.rowOf(3).fingerprint).capAcknowledgement()
            assertTrue(ask(teamId).teams.isEmpty())
            // The plan's figure for sprint 2 moves: the stored fingerprint is no longer the row's.
            jbSql("UPDATE team_capacity_periods SET md_per_week = 17 WHERE team_id = ? AND flow_sprint_id = 2", teamId.toInt())
            val reopened = ask(teamId).team(teamId)
            assertEquals(1, reopened.flags.single().count, "only the changed sprint is open again")
            assertEquals(1, reopened.ranges.size)
            assertEquals(LocalDate.parse("2049-03-15"), reopened.ranges.single().start)
        }
    }

    @Test
    fun `a disabled connection raises nothing, and enabling it again does`() = testApplication {
        val world = dayTwo("flowflag4")
        with(world) {
            jbSql("UPDATE flow_connections SET enabled = FALSE WHERE id = ?", mirror.connectionId.toInt())
            assertTrue(ask(teamId).teams.isEmpty())
            jbSql("UPDATE flow_connections SET enabled = TRUE WHERE id = ?", mirror.connectionId.toInt())
            assertEquals(2, ask(teamId).team(teamId).flags.single().count)
        }
    }

    @Test
    fun `a gone Flow team flags at WARNING with count 1 and no range`() = testApplication {
        val world = dayTwo("flowflag5")
        with(world) {
            val other = w.requireTeams().otherTeamId
            val team = ask(other).team(other)
            val flag = team.flags.single()
            assertEquals(listOf(FlagSeverity.WARNING, 1), listOf(flag.severity, flag.count))
            assertEquals(emptyList(), team.ranges)
        }
    }

    @Test
    fun `a team whose every row is CAPACITY_MISSING flags at INFO`() = testApplication {
        val world = dayTwo("flowflag6")
        with(world) {
            jbSql("DELETE FROM team_capacity_periods WHERE team_id = ?", teamId.toInt())
            val rows: List<CapacityDeviation> = w.admin.client.rowsOf()
            assertTrue(rows.isNotEmpty() && rows.all { it.kind == CapacityDeviationKind.CAPACITY_MISSING }, "no capacity: $rows")
            val team = ask(teamId).team(teamId)
            val flag = team.flags.single()
            assertEquals(listOf(FlagSeverity.INFO, rows.size), listOf(flag.severity, flag.count))
            assertTrue(team.ranges.isNotEmpty() && team.ranges.all { it.severity == FlagSeverity.INFO })
        }
    }

    @Test
    fun `an unlinked team, no team id and a request naming nodes AND a team answer only what they ask`() = testApplication {
        val world = dayTwo("flowflag7")
        with(world) {
            val unlinked = TestTeams.seed(planName("flowflag-unlinked"))
            assertTrue(ask(unlinked).teams.isEmpty(), "an unlinked team: no flag, no error")
            val noTeam = ask(null)
            assertTrue(noTeam.teams.isEmpty() && noTeam.projects.isEmpty() && noTeam.milestones.isEmpty() && noTeam.sites.isEmpty())
            val both = ask(teamId, milestones = listOf(w.projectId))
            assertEquals(setOf(teamId), both.teams.keys)
            assertTrue(both.projects.isEmpty() && both.milestones.isEmpty() && both.sites.isEmpty(), "the node half is the Jira source's")
        }
    }
}
