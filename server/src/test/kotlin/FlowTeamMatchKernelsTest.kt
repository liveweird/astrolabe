package ch.nokillswit

import ch.nokillswit.flow.FlowTeamMatchKernels
import kotlin.test.Test
import kotlin.test.assertEquals

/** The match by name, pure: the fold, "exactly one", the symmetric rule and the order independence. */
class FlowTeamMatchKernelsTest {
    private fun suggest(flow: List<Pair<Int, String>>, teams: List<Pair<UInt, String>>) = FlowTeamMatchKernels.suggest(flow, teams)

    @Test
    fun `the fold trims, collapses every run of whitespace and lowercases - and keeps accents`() {
        assertEquals("platform team", FlowTeamMatchKernels.fold("  Platform \t  TEAM\n"))
        assertEquals("zespół płatności", FlowTeamMatchKernels.fold("Zespół   PŁATNOŚCI"))
        assertEquals("", FlowTeamMatchKernels.fold("   "))
        // Unicode whitespace folds too: a no-break space (U+00A0) or a thin space pasted from a document is a space.
        assertEquals("platform team", FlowTeamMatchKernels.fold("\u00A0Platform\u00A0\u2009 Team\u00A0"))
        // Accents count: the folded forms differ.
        assertEquals(false, FlowTeamMatchKernels.fold("Płatności") == FlowTeamMatchKernels.fold("Platnosci"))
    }

    @Test
    fun `a Flow team matches the one team whose folded name equals its own`() {
        val result = suggest(
            flow = listOf(1 to "Platform", 2 to "  PAYMENTS  team", 3 to "Mobile"),
            teams = listOf(10u to "platform", 20u to "Payments Team", 30u to "Web"),
        )
        assertEquals(mapOf(1 to 10u, 2 to 20u), result)
    }

    @Test
    fun `accents count - a name that differs only by an accent has no suggestion`() {
        assertEquals(emptyMap(), suggest(listOf(1 to "Płatności"), listOf(10u to "Platnosci")))
        assertEquals(mapOf(1 to 10u), suggest(listOf(1 to "Płatności"), listOf(10u to "płatności")))
    }

    @Test
    fun `a no-break space in a name does not defeat the match`() {
        assertEquals(mapOf(1 to 10u), suggest(listOf(1 to "Platform\u00A0Team"), listOf(10u to "platform team")))
    }

    @Test
    fun `two teams with the same folded name are no unique match`() {
        assertEquals(emptyMap(), suggest(listOf(1 to "Platform"), listOf(10u to "Platform", 11u to "platform ")))
    }

    @Test
    fun `two Flow teams that fold to one name suggest nothing - a team is never asked for twice`() {
        assertEquals(emptyMap(), suggest(listOf(1 to "Platform", 2 to "PLATFORM"), listOf(10u to "Platform")))
        // The unambiguous neighbour is unaffected.
        val flow = listOf(1 to "Platform", 2 to "PLATFORM", 3 to "Mobile")
        assertEquals(mapOf(3 to 11u), suggest(flow, listOf(10u to "Platform", 11u to "Mobile")))
    }

    @Test
    fun `nothing to match gives nothing`() {
        assertEquals(emptyMap(), suggest(emptyList(), listOf(10u to "Platform")))
        assertEquals(emptyMap(), suggest(listOf(1 to "Platform"), emptyList()))
        assertEquals(emptyMap(), suggest(listOf(1 to "Platform"), listOf(10u to "Mobile")))
    }

    @Test
    fun `the answer does not depend on the order of the inputs`() {
        val flow = listOf(1 to "A", 2 to "b", 3 to "C c")
        val teams = listOf(10u to "a", 20u to "B", 30u to "c  C")
        assertEquals(suggest(flow, teams), suggest(flow.reversed(), teams.reversed()))
        assertEquals(mapOf(1 to 10u, 2 to 20u, 3 to 30u), suggest(flow, teams))
    }
}
