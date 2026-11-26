package ch.nokillswit

import ch.nokillswit.teams.TeamColour
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

/**
 * The palette (V35): the enum is the spec's `TeamColour` in the same order (the order IS the assignment order, and the stored keys are
 * never renamed or removed), and [TeamColour.leastUsed] is pure: the fewest teams win, a tie goes to the earlier key. The SQL side
 * (the CHECK and the backfill) is pinned by `MigrationChecksumTest`; the routes by `TeamTest`.
 */
class TeamColourTest {
    @Test
    fun `the enum equals the spec's TeamColour in palette order`() {
        val schema = assertNotNull(OpenApiSpec.parsed.components.schemas["TeamColour"], "TeamColour schema")
        assertEquals(schema.enum.filterNotNull().map { it.toString() }, TeamColour.entries.map { it.name })
        assertEquals(12, TeamColour.entries.size)
    }

    @Test
    fun `the palette is the migration's CHECK list, key for key`() {
        val sql = java.io.File("src/main/resources/db/migration/V35__team_colour.sql").readText()
        val check = sql.substringAfter("CHECK (colour IN (").substringBefore("))")
        assertEquals(TeamColour.entries.joinToString(",") { "'${it.name}'" }, check)
        // The backfill's array is the same list in the same order: palette order = assignment order.
        val array = sql.substringAfter("(ARRAY[").substringBefore("])")
        assertEquals(check, array)
    }

    @Test
    fun `an empty plan gets the first colour`() {
        assertEquals(TeamColour.INDIGO, TeamColour.leastUsed(emptyMap()))
    }

    @Test
    fun `the fewest users win and a tie goes to the earlier key`() {
        val used = TeamColour.entries.associateWith { 2 }.toMutableMap()
        used[TeamColour.LIME] = 1
        used[TeamColour.AZURE] = 1
        assertEquals(TeamColour.LIME, TeamColour.leastUsed(used))
        used[TeamColour.LIME] = 3
        assertEquals(TeamColour.AZURE, TeamColour.leastUsed(used))
    }

    @Test
    fun `a colour absent from the counts counts as unused`() {
        val counts = TeamColour.entries.filter { it != TeamColour.GREEN }.associateWith { 1 }
        assertEquals(TeamColour.GREEN, TeamColour.leastUsed(counts))
    }

    @Test
    fun `sharing is allowed once every colour is taken`() {
        val counts = TeamColour.entries.associateWith { 1 } + (TeamColour.INDIGO to 2)
        assertEquals(TeamColour.TEAL, TeamColour.leastUsed(counts))
    }
}
