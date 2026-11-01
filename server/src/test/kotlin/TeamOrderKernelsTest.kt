package ch.nokillswit

import ch.nokillswit.planning.OrderKey
import ch.nokillswit.planning.effectiveOrder
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The pure effective order of a team's milestones (no server, no database): the stored custom position first, then the project's global
 * rank, then the plain tiebreaks. Two projects `alpha` (id 1) and `beta` (id 2); `alpha` outranks `beta` unless a case says otherwise.
 */
class TeamOrderKernelsTest {
    private fun key(
        id: UInt,
        project: String = "alpha",
        projectId: UInt = if (project == "alpha") 1u else 2u,
        custom: Int? = null,
        rank: Int? = if (project == "alpha") 1 else 2,
        start: String? = "2027-02-01",
        end: String? = "2027-02-05",
        name: String = "m$id",
    ) = OrderKey(custom, rank, project, projectId, start?.let(LocalDate::parse), end?.let(LocalDate::parse), name, id)

    private fun order(vararg keys: OrderKey): List<UInt> = effectiveOrder(keys.toList()) { it }.map { it.id }

    @Test
    fun `without an override the order is the project rank, project by project`() {
        val a1 = key(1u, "alpha")
        val a2 = key(2u, "alpha", start = "2027-03-01", end = "2027-03-05")
        val b1 = key(3u, "beta", start = "2027-01-01", end = "2027-01-05")
        assertEquals(listOf(1u, 2u, 3u), order(b1, a2, a1), "alpha's milestones first, even though beta's is earlier in time")
    }

    @Test
    fun `a ranked project comes before an unranked one, and unranked projects fall back to name then id`() {
        val ranked = key(1u, "beta", rank = 7)
        val unrankedB = key(2u, "Bravo", projectId = 30u, rank = null)
        val unrankedA = key(3u, "alpha-2", projectId = 20u, rank = null)
        val sameNameLowId = key(4u, "alpha-2", projectId = 10u, rank = null)
        assertEquals(listOf(1u, 4u, 3u, 2u), order(unrankedB, unrankedA, sameNameLowId, ranked), "case-insensitive name, then project id")
    }

    @Test
    fun `inside a project the order is start, end, name case-insensitively, then id`() {
        val late = key(1u, start = "2027-02-08", end = "2027-02-09")
        val earlyLong = key(2u, start = "2027-02-01", end = "2027-02-12")
        val earlyShort = key(3u, start = "2027-02-01", end = "2027-02-05")
        val sameSpanB = key(4u, name = "Bravo")
        val sameSpanA = key(5u, name = "alpha")
        val twin = key(6u, name = "ALPHA")
        assertEquals(
            listOf(5u, 6u, 4u, 3u, 2u, 1u),
            order(late, earlyLong, earlyShort, sameSpanB, sameSpanA, twin),
            "02-01..02-05 first (alpha, ALPHA by id, Bravo, m3), then the longer span, then the later start",
        )
    }

    @Test
    fun `listed milestones come first exactly as listed, whatever their project's rank - the manager's order`() {
        val a1 = key(1u, "alpha")
        val a2 = key(2u, "alpha", start = "2027-03-01", end = "2027-03-05")
        val b1 = key(3u, "beta", custom = 1)
        assertEquals(listOf(3u, 1u, 2u), order(a1, a2, b1), "the lower-ranked project's milestone first; the unlisted follow by rank")
        assertEquals(listOf(3u, 2u, 1u), order(a1, a2.copy(customPosition = 2), b1), "listed ones in their listed order, then the tail")
        assertEquals(listOf(2u, 3u, 1u), order(a1, a2.copy(customPosition = 1), b1.copy(customPosition = 2)), "positions, not ranks")
    }

    @Test
    fun `a rank change reorders only the unlisted tail - the listed positions are the team's own`() {
        // The manager listed b1 then a2. a1, a3 (alpha) and b2 (beta) are unlisted newcomers.
        fun team(alphaRank: Int?, betaRank: Int?): List<UInt> {
            val a1 = key(1u, "alpha", rank = alphaRank)
            val a2 = key(2u, "alpha", rank = alphaRank, custom = 2)
            val a3 = key(4u, "alpha", rank = alphaRank, start = "2027-04-01", end = "2027-04-02")
            val b1 = key(3u, "beta", rank = betaRank, custom = 1)
            val b2 = key(5u, "beta", rank = betaRank)
            return order(b2, a3, a2, b1, a1)
        }
        assertEquals(listOf(3u, 2u, 1u, 4u, 5u), team(alphaRank = 1, betaRank = 2), "alpha outranks beta: the tail is a1, a3, b2")
        assertEquals(listOf(3u, 2u, 5u, 1u, 4u), team(alphaRank = 2, betaRank = 1), "beta outranks alpha: the tail is b2, a1, a3")
        assertEquals(listOf(3u, 2u, 1u, 4u, 5u), team(alphaRank = null, betaRank = null), "unranked: by project name, alpha first")
    }

    @Test
    fun `an unscheduled milestone has no dates - undated work sorts last inside its project, then by name and id`() {
        val scheduled = key(1u)
        val zebra = key(2u, start = null, end = null, name = "zebra")
        val ant = key(3u, start = null, end = null, name = "Ant")
        val otherProject = key(4u, "beta")
        val expected = listOf(1u, 3u, 2u, 4u)
        assertEquals(expected, order(zebra, ant, otherProject, scheduled), "after its project's dated work, before the next project")
    }

    @Test
    fun `an empty team has an empty order`() {
        assertEquals(emptyList(), order())
    }
}
