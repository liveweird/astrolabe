package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CompositeExternalFlagSource
import ch.nokillswit.planning.ExternalFlagRequest
import ch.nokillswit.planning.ExternalFlagSource
import ch.nokillswit.planning.ExternalFlags
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.FlaggedRange
import ch.nokillswit.planning.JiraLink
import ch.nokillswit.planning.JiraSite
import ch.nokillswit.planning.JiraSiteState
import ch.nokillswit.planning.NodeExternal
import ch.nokillswit.planning.PlanFlag
import ch.nokillswit.planning.TeamExternal
import kotlinx.coroutines.runBlocking
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** The composite source (1.9), pure: two fake sources merged per node, per team and per site. */
class CompositeExternalFlagSourceTest {
    private class Fake(val answer: ExternalFlags) : ExternalFlagSource {
        var asked: ExternalFlagRequest? = null

        override suspend fun flagsInTransaction(request: ExternalFlagRequest): ExternalFlags = answer.also { asked = request }
    }

    private fun flag(kind: FlagKind, severity: FlagSeverity, count: Int? = null) = PlanFlag(kind, severity, null, null, null, count = count)

    private fun link(binding: UInt, connection: UInt) = JiraLink(binding, connection, "K-$binding", null, null, null)

    private val request = ExternalFlagRequest(emptyList(), listOf(1u), WorkingCalendar.MON_FRI, teamId = 9u)

    private fun ask(vararg sources: ExternalFlagSource): ExternalFlags =
        runBlocking { CompositeExternalFlagSource(sources.toList()).flagsInTransaction(request) }

    @Test
    fun `every source gets the same request, and an empty source adds nothing`() {
        val first = Fake(ExternalFlags())
        val second = Fake(ExternalFlags())
        val merged = ask(first, second)
        assertSame(request, first.asked)
        assertSame(request, second.asked)
        assertTrue(merged.projects.isEmpty() && merged.milestones.isEmpty() && merged.sites.isEmpty() && merged.teams.isEmpty())
        assertTrue(ask().teams.isEmpty(), "no source at all")
    }

    @Test
    fun `a node takes the first non-null link and every source's flags in FLAG_ORDER`() {
        val jira = Fake(
            ExternalFlags(
                milestones = mapOf(
                    1u to NodeExternal(link(1u, 5u), listOf(flag(FlagKind.JIRA_DEVIATION, FlagSeverity.INFO))),
                    2u to NodeExternal(null, emptyList()),
                ),
                projects = mapOf(3u to NodeExternal(link(3u, 5u), emptyList())),
            ),
        )
        val other = Fake(
            ExternalFlags(
                milestones = mapOf(
                    1u to NodeExternal(link(10u, 6u), listOf(flag(FlagKind.DRIFT_END_LATE, FlagSeverity.WARNING))),
                    4u to NodeExternal(null, listOf(flag(FlagKind.JIRA_DEVIATION, FlagSeverity.WARNING))),
                ),
            ),
        )
        val merged = ask(jira, other)
        assertEquals(setOf(1u, 2u, 4u), merged.milestones.keys)
        val one = merged.milestone(1u)
        assertEquals(1u, one.jira?.bindingId, "the first non-null link")
        assertEquals(listOf(FlagKind.DRIFT_END_LATE, FlagKind.JIRA_DEVIATION), one.flags.map { it.kind }, "WARNING first, then the other")
        assertNull(merged.milestone(2u).jira)
        assertEquals(setOf(3u), merged.projects.keys)
        assertEquals(1, merged.milestone(4u).flags.size)
    }

    @Test
    fun `a team's flags are merged in FLAG_ORDER and its ranges concatenated`() {
        val range = { from: String, severity: FlagSeverity ->
            FlaggedRange(LocalDate.parse(from), LocalDate.parse(from).plusDays(4), severity)
        }
        val a = Fake(
            ExternalFlags(
                teams = mapOf(
                    9u to TeamExternal(
                        listOf(flag(FlagKind.FLOW_CAPACITY, FlagSeverity.INFO, 1)),
                        listOf(range("2049-03-15", FlagSeverity.INFO)),
                    ),
                ),
            ),
        )
        val b = Fake(
            ExternalFlags(
                teams = mapOf(
                    9u to TeamExternal(
                        listOf(flag(FlagKind.RANK_INVERSION, FlagSeverity.WARNING)),
                        listOf(range("2049-03-22", FlagSeverity.WARNING)),
                    ),
                    8u to TeamExternal(emptyList(), emptyList()),
                ),
            ),
        )
        val merged = ask(a, b)
        assertEquals(setOf(8u, 9u), merged.teams.keys)
        assertEquals(listOf(FlagKind.RANK_INVERSION, FlagKind.FLOW_CAPACITY), merged.team(9u).flags.map { it.kind })
        assertEquals(listOf("2049-03-15", "2049-03-22"), merged.team(9u).ranges.map { it.start.toString() })
    }

    @Test
    fun `the sites are the union, one per connection, sorted by id`() {
        fun site(id: UInt, url: String) = JiraSite(id, url, JiraSiteState.CURRENT, mappingOk = true)
        val a = Fake(ExternalFlags(sites = listOf(site(7u, "https://a.example"), site(3u, "https://b.example"))))
        val b = Fake(ExternalFlags(sites = listOf(site(3u, "https://b.example"), site(5u, "https://c.example"))))
        assertEquals(listOf(3u, 5u, 7u), ask(a, b).sites.map { it.connectionId })
    }
}
