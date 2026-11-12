package ch.nokillswit

import ch.nokillswit.jira.ImportPlan
import ch.nokillswit.jira.ImportTree
import ch.nokillswit.jira.JiraImportItem
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
            issue("700", JIRA_EPIC, "Bound epic", parent = "200"),
            issue("800", JIRA_EPIC, "Bound under visible", parent = "100"),
            issue("900", JIRA_EPIC, "Bound under absent", parent = "99999"),
        ),
        tree = tree,
        holders = listOf(holder("100", JiraLevel.PROGRAM, 5u, "Held program"), holder("700", JiraLevel.MILESTONE, 6u, "Bound epic"),
            holder("800", JiraLevel.MILESTONE, 7u, "Bound under visible"), holder("900", JiraLevel.MILESTONE, 8u, "Bound under absent"),
        ),
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
    fun `under an active filter a redacted row loses its key, its Jira id and its parent's, and comes after every visible row`() {
        val plan = case(teamId = null).plan()
        val plain = redactForNonAdmin(plan).items
        val shown = redactForNonAdmin(plan, filterActive = true).items
        assertEquals(plan.rows.size, shown.size)
        val hiddenFrom = shown.indexOfFirst { it.issueKey == null }
        assertTrue(shown.drop(hiddenFrom).all { it.issueKey == null }, "the redacted rows are last")
        assertTrue(shown.take(hiddenFrom).none { it.issueKey == null }, "the visible rows are first")
        // The visible rows are the plain redaction's visible rows, in their order.
        val visible = plain.filter { it.action != JiraImportAction.SKIP || it.reason == JiraImportReason.ALREADY_BOUND }
        assertEquals(visible.map { it.jiraId }, shown.take(hiddenFrom).map { it.jiraId })
        // An ALREADY_BOUND row keeps its parent only when the parent is a visible row: 700 under the redacted 200 and 900 under a
        // parent the browse never listed look alike; 800 under the visible (held) program 100 keeps it.
        fun parentOf(id: String) = shown.single { it.jiraId == id }.let { listOf(it.reason, it.parentJiraId, it.parentIssueKey) }
        assertEquals(listOf(JiraImportReason.ALREADY_BOUND, null, null), parentOf("700"))
        assertEquals(listOf(JiraImportReason.ALREADY_BOUND, null, null), parentOf("900"))
        assertEquals(listOf(JiraImportReason.ALREADY_BOUND, "100", "IMP-100"), parentOf("800"))
        assertEquals("IMP-700", shown.single { it.jiraId == "700" }.issueKey, "a bound row keeps its own key")
        val redacted = plan.rows.map { it.item }
            .filter { it.action == JiraImportAction.SKIP && it.reason != JiraImportReason.ALREADY_BOUND }
        assertEquals(redacted.size, shown.size - hiddenFrom)
        shown.drop(hiddenFrom).forEachIndexed { index, item ->
            assertEquals("hidden-${hiddenFrom + index + 1}", item.jiraId)
            assertEquals(
                listOf(null, null, null, "", ""),
                listOf(item.issueKey, item.parentJiraId, item.parentIssueKey, item.summary, item.name),
            )
        }
        assertTrue(shown.count { it.issueKey == null } >= 3, "at least the three skips the plain test lists")
    }

    @Test
    fun `the redacted rows are ordered by what they show, never by id`() {
        val plan = case(teamId = null).plan()
        val redacted = plan.rows.map { it.item }
            .filter { it.action == JiraImportAction.SKIP && it.reason != JiraImportReason.ALREADY_BOUND }
        // 300 (PARENT_SKIPPED) has a lower id than 500 and 600 (NO_TEAM), but NO_TEAM sorts first: the reason order wins over the id order.
        val ids = redacted.map { it.jiraId }
        assertTrue(ids.indexOf("300") < ids.indexOf("500"), "the plan lists them by id")
        val hidden = redactForNonAdmin(plan, filterActive = true).items.filter { it.issueKey == null }
        val levelThenReason = compareBy<JiraImportItem>({ it.level.ordinal }, { it.reason!!.ordinal })
        assertEquals(redacted.sortedWith(levelThenReason).map { it.level to it.reason }, hidden.map { it.level to it.reason })
        assertEquals(JiraImportReason.PARENT_SKIPPED, hidden.last().reason, "after the NO_TEAM pair, whatever the ids")
        // 500 and 600 show the same (an epic, NO_TEAM): the answer does not depend on the order the plan lists the rows in.
        val reversed = ImportPlan(plan.asOf, plan.rows.reversed(), plan.truncated, plan.unmatchedTeams, plan.vanished)
        val again = redactForNonAdmin(reversed, filterActive = true).items.filter { it.issueKey == null }
        assertEquals(hidden, again, "the hidden rows are the same list whatever the plan's (id) order")
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
