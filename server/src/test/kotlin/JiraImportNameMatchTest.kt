package ch.nokillswit

import ch.nokillswit.jira.ImportNameMatch
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The strict similarity rule and the unique-both-ways pairing of the import's suggested matches (1.15), as pure vectors. */
class JiraImportNameMatchTest {
    private fun similar(a: String, b: String): Boolean {
        val forward = ImportNameMatch.similar(a, b)
        assertEquals(forward, ImportNameMatch.similar(b, a), "similar is symmetric: '$a' / '$b'")
        return forward
    }

    @Test
    fun `names with the same words, or one that only adds words, are similar`() {
        listOf(
            "Checkout redesign" to "checkout  REDESIGN",
            "Płatności mobilne" to "Platnosci mobilne",
            "Customer portal" to "Portal: customer",
            "Documentation" to "Documentation (renamed)",
            "Customer portal" to "New customer portal",
            "Mobile app" to "Mobile app rollout",
        ).forEach { (a, b) -> assertTrue(similar(a, b), "'$a' / '$b'") }
    }

    @Test
    fun `siblings that differ by a number, a letter or a word are not similar`() {
        listOf(
            "Team A" to "Team B",
            "Team" to "Team A",
            "Phase 1" to "Phase 2",
            "Release" to "Release 2",
            "Phase" to "Phase II",
            "Billing revamp" to "Billing redesign",
            "Customer portal redesign" to "Customer portal API",
            "API" to "API gateway",
            "Custmer portal" to "Customer portal",
            "Check-out" to "Checkout",
        ).forEach { (a, b) -> assertFalse(similar(a, b), "'$a' / '$b'") }
    }

    @Test
    fun `a name with no word is similar to nothing, not even to itself`() {
        assertFalse(similar("", ""))
        assertFalse(similar("---", "..."))
        assertFalse(similar("!!!", "Portal"))
    }

    @Test
    fun `a word counts as often as it occurs`() {
        assertFalse(similar("Data data", "Data pipeline"), "the shorter name uses 'data' twice, the longer one once")
        assertTrue(similar("Data data", "Data data pipeline"))
    }

    @Test
    fun `every numbering form is identity - a digit, one character, a Roman numeral up to ix`() {
        listOf("2", "a", "i", "w", "ii", "iii", "iv", "vi", "vii", "viii", "ix", "v2", "q3").forEach { numbering ->
            assertFalse(similar("Portal", "Portal $numbering"), "'$numbering' is a numbering word")
            assertTrue(similar("Portal $numbering", "$numbering portal"), "the same numbering word on both sides")
        }
        assertTrue(similar("Portal rollout", "Portal rollout plan"), "an ordinary word may be added ('plan' is not numbering)")
        assertFalse(similar("Release 2 notes", "Release 3 notes"))
    }

    @Test
    fun `exactly half of the longer name's letters is similar, one letter less is not`() {
        // letters: "abcd" = 4, "abcd efgh" = 8 -> 2 x 4 >= 8 holds; "abcd efghi" = 9 -> 8 < 9 fails.
        assertTrue(similar("Abcd", "Abcd Efgh"))
        assertFalse(similar("Abcd", "Abcd Efghi"))
    }

    @Test
    fun `names at the 100-character cap are compared the same way`() {
        val long = ('a'..'h').joinToString(" ") { it.toString().repeat(11) }
        assertEquals(95, long.length)
        assertTrue(similar(long, long.uppercase()))
        assertTrue(similar(long, "$long extra"))
        assertFalse(similar(long, "$long ${"extra ".repeat(40).trim()}"))
    }

    @Test
    fun `pairs - unique both ways, and the same answer for any input order`() {
        val rows = listOf("100" to "Checkout redesign", "101" to "Mobile app", "102" to "Billing revamp")
        val nodes = listOf(1u to "Redesign of checkout", 2u to "Mobile app rollout", 3u to "Billing redesign")
        val expected = mapOf("100" to 1u, "101" to 2u)
        assertEquals(expected, ImportNameMatch.pairs(rows, nodes))
        assertEquals(expected, ImportNameMatch.pairs(rows.reversed(), nodes.reversed()))
        assertEquals(expected, ImportNameMatch.pairs(rows.shuffled(java.util.Random(7)), nodes.shuffled(java.util.Random(11))))
    }

    @Test
    fun `pairs - two nodes for one row propose nothing, and neither does one node for two rows`() {
        val twoNodes = ImportNameMatch.pairs(listOf("1" to "Portal"), listOf(1u to "Portal north", 2u to "Portal south"))
        assertTrue(twoNodes.isEmpty(), "two candidates for one row")
        val twoRows = ImportNameMatch.pairs(listOf("1" to "Portal north", "2" to "Portal south"), listOf(1u to "Portal"))
        assertTrue(twoRows.isEmpty(), "one candidate for two rows")
        // The other rows of the scope stay paired: an ambiguity only silences the pairs it touches.
        val mixed = ImportNameMatch.pairs(
            listOf("1" to "Portal north", "2" to "Portal south", "3" to "Checkout redesign"),
            listOf(1u to "Portal", 2u to "Redesign checkout"),
        )
        assertEquals(mapOf("3" to 2u), mixed)
    }

    @Test
    fun `pairs - rows and nodes that share no word are never compared, and an empty side pairs nothing`() {
        assertTrue(ImportNameMatch.pairs(listOf("1" to "Alpha"), listOf(1u to "Beta")).isEmpty())
        assertTrue(ImportNameMatch.pairs(emptyList<Pair<String, String>>(), listOf(1u to "Beta")).isEmpty())
        assertTrue(ImportNameMatch.pairs(listOf("1" to "Alpha"), emptyList<Pair<UInt, String>>()).isEmpty())
    }

    @Test
    fun `a number character of any kind is numbering, consistent with the split on letters and digits`() {
        assertFalse(similar("Cell", "Cell x²"), "x² holds a number character")
        assertTrue(similar("Cell x²", "x² cell"))
        assertFalse(similar("Cell x²", "Cell x³"))
        assertFalse(similar("Cell", "Cell ٣"), "an Arabic-Indic digit")
    }

    @Test
    fun `a Roman numeral above ix is an ordinary word - Phase and Phase XII are similar, Phase XII and Phase II are not`() {
        assertTrue(similar("Phase", "Phase XII"))
        assertFalse(similar("Phase XII", "Phase II"))
        assertFalse(similar("Phase", "Phase IX"))
    }
}
