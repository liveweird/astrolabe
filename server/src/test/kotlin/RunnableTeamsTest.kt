package ch.nokillswit

import ch.nokillswit.planning.CrossTeamProposalService
import ch.nokillswit.planning.PlanActor
import kotlinx.coroutines.runBlocking
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RunnableTeamsTest {
    @Test
    fun `eligibility and name ordering apply before the bounded picker is truncated`() = runBlocking {
        val marker = UUID.randomUUID().toString().take(8)
        val second = TestTeams.seed("Ż$marker-b")
        val third = TestTeams.seed("ż$marker-c")
        val first = TestTeams.seed("ż$marker-a")
        val ineligible = TestTeams.seed("A$marker-0")
        val seeded = listOf(first, second, third, ineligible)
        try {
            val actor = PlanActor(
                isAdmin = false,
                personId = null,
                roadmapEditor = false,
                managedTeamIds = setOf(first, second, third),
            )

            val result = CrossTeamProposalService(sharedDatabaseForTests()).runnableTeams(actor, limit = 2)

            assertEquals(listOf(first, second), result.items.map { it.id })
            assertTrue(result.truncated)
            assertTrue(ineligible !in result.items.map { it.id })
        } finally {
            // The shared container outlives the class: the accented rows would otherwise skew every later alphabetical assertion.
            seeded.forEach { jbSql("DELETE FROM teams WHERE id = ?", it.toInt()) }
        }
    }
}
