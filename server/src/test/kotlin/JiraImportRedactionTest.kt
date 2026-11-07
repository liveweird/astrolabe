package ch.nokillswit

import ch.nokillswit.jira.ImportTree
import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportInfo
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.redactForNonAdmin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** `redactForNonAdmin`: what a non-admin's preview may show of a row nothing guards (the pure function; the route applies it). */
class JiraImportRedactionTest {
    private val tree = ImportTree(listOf(node(1u, "Stream program")), listOf(node(30u, "Default project", 1u)), emptyList())
    private val long = "x".repeat(110)

    private fun case(teamId: UInt?) = ImportCase(
        issues = listOf(
            issue("100", JIRA_PROGRAM, "Held program"),
            issue("200", JIRA_PROJECT, "Hidden project", parent = "100"),
            issue("300", JIRA_EPIC, long, parent = "200", team = "Platform", start = MONDAY, end = MONDAY),
            issue("400", JIRA_EPIC, "Visible epic", team = "Platform"),
            issue("500", JIRA_EPIC, "Team-less epic", team = "Skipped Team", start = MONDAY, end = MONDAY, estimate = "3"),
            issue("600", JIRA_EPIC, "Elsewhere epic", team = "Elsewhere"),
        ),
        tree = tree,
        holders = listOf(holder("100", JiraLevel.PROGRAM, 5u, "Held program")),
        defaults = JiraImportDefaults(projectId = 30u, teamId = teamId),
    )

    @Test
    fun `a skipped row loses its summary, name and infos, except ALREADY_BOUND, which names its holder`() {
        val plan = case(teamId = null).plan()
        // Before: the skipped rows carry Jira's text (the truncated one even an info).
        assertEquals("Hidden project", plan.row("200").item.summary)
        assertEquals(listOf(JiraImportInfo.NAME_TRUNCATED), plan.row("300").item.infos)
        val shown = redactForNonAdmin(plan).items.associateBy { it.jiraId }
        val held = shown.getValue("100")
        assertEquals(listOf(JiraImportReason.ALREADY_BOUND, "Held program"), listOf(held.reason, held.summary))
        assertEquals("Held program", held.target!!.nodeName)
        val skipped = listOf(
            "200" to JiraImportReason.NO_PARENT, "300" to JiraImportReason.PARENT_SKIPPED, "500" to JiraImportReason.NO_TEAM,
        )
        for ((id, reason) in skipped) {
            val row = shown.getValue(id)
            assertEquals(listOf(JiraImportAction.SKIP, reason), listOf(row.action, row.reason), id)
            assertEquals(listOf("", "IMP-$id"), listOf(row.summary, row.name), id)
            assertTrue(row.infos.isEmpty(), id)
            assertEquals(listOf(null, null, null, false), listOf(row.startDate, row.endDate, row.team, row.scheduled), id)
        }
        // A row that WILL be created is shown in full; the order and the key/level/reason fields stay.
        val created = shown.getValue("400")
        assertEquals(listOf(JiraImportAction.CREATE, "Visible epic", "Visible epic"), listOf(created.action, created.summary, created.name))
        assertEquals(plan.rows.map { it.item.jiraId }, redactForNonAdmin(plan).items.map { it.jiraId })
        assertEquals(JiraLevel.PROJECT, shown.getValue("200").level)
    }

    @Test
    fun `the unmatched team names come from the rows that would be created only`() {
        val noDefault = case(teamId = null).plan()
        assertEquals(listOf("Elsewhere", "Skipped Team"), noDefault.unmatchedTeams, "the kernel lists the skipped row's team too")
        assertEquals(emptyList(), redactForNonAdmin(noDefault).unmatchedTeams, "no row with an unmatched team is created without a default")
        val withDefault = case(teamId = PLATFORM.id).plan()
        assertEquals(listOf("Elsewhere", "Skipped Team"), withDefault.unmatchedTeams)
        assertEquals(listOf("Elsewhere", "Skipped Team"), redactForNonAdmin(withDefault).unmatchedTeams, "both rows are created now")
        assertTrue(withDefault.row("500").item.action == JiraImportAction.CREATE)
    }
}
