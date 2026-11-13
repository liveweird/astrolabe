package ch.nokillswit

import ch.nokillswit.jira.ImportRow
import ch.nokillswit.jira.ImportTree
import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportInfo
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A created project's target window from Jira's dates (1.14), as pure vectors: both dates in order, else none and no refusal; the dates
 * shown on the row are the window that will be written; copyDates off, a BIND and the other levels never carry one.
 */
class JiraImportTargetWindowKernelTest {
    private val stream = ImportTree(
        programs = listOf(node(7u, "Platform program")),
        projects = listOf(node(7u, "Existing project", parentId = 7u)),
        milestones = emptyList(),
    )

    private fun project(start: String? = null, end: String? = null, copyDates: Boolean = true): ImportRow =
        ImportCase(
            listOf(issue("200", JIRA_PROJECT, "Initiative A", start = start, end = end)),
            tree = stream, defaults = JiraImportDefaults(programId = 7u, teamId = 10u), copyDates = copyDates,
        ).plan().row("200")

    @Test
    fun `both dates in order are the window, shown on the row, with no note`() {
        val row = project(start = "2027-02-01", end = "2027-03-31")
        assertEquals(JiraImportAction.CREATE, row.item.action)
        assertEquals(LocalDate.parse("2027-02-01"), row.window!!.start)
        assertEquals(LocalDate.parse("2027-03-31"), row.window.end)
        assertEquals("2027-02-01", row.item.startDate)
        assertEquals("2027-03-31", row.item.endDate)
        assertTrue(row.item.infos.isEmpty())
        assertEquals(false, row.item.scheduled, "a project is never `scheduled`: that is the milestone's word")
    }

    @Test
    fun `a one-day window and a window on a weekend are copied as they are - a target window is not a working-day span`() {
        assertEquals(LocalDate.parse("2027-02-06"), project(start = "2027-02-06", end = "2027-02-06").window!!.start)
        assertEquals(LocalDate.parse("2027-02-07"), project(start = "2027-02-06", end = "2027-02-07").window!!.end)
    }

    @Test
    fun `one date alone, an end before the start and a date outside the plan's years give no window and the info, never a skip`() {
        val cases = listOf(
            "only the start" to project(start = "2027-02-01"),
            "only the end" to project(end = "2027-03-31"),
            "a reversed pair" to project(start = "2027-03-31", end = "2027-02-01"),
            "before 1900" to project(start = "1899-12-31", end = "2027-01-01"),
            "after 2999" to project(start = "2027-01-01", end = "3000-01-01"),
        )
        for ((label, row) in cases) {
            assertEquals(JiraImportAction.CREATE, row.item.action, label)
            assertNull(row.window, label)
            assertNull(row.item.startDate, label)
            assertNull(row.item.endDate, label)
            assertEquals(listOf(JiraImportInfo.TARGET_NOT_COPIED), row.item.infos, label)
        }
    }

    @Test
    fun `a project Jira gives no dates at all is created without a window and without a note`() {
        val row = project()
        assertNull(row.window)
        assertTrue(row.item.infos.isEmpty())
    }

    @Test
    fun `copyDates off copies no window, shows no dates and says nothing`() {
        val row = project(start = "2027-02-01", end = "2027-03-31", copyDates = false)
        assertNull(row.window)
        assertNull(row.item.startDate)
        assertTrue(row.item.infos.isEmpty())
        assertTrue(project(start = "2027-02-01", copyDates = false).item.infos.isEmpty())
    }

    @Test
    fun `a BIND, a program and a milestone never carry a window, whatever dates Jira gives`() {
        val bound = ImportCase(
            listOf(issue("200", JIRA_PROJECT, "Existing project", parent = "100", start = "2027-02-01", end = "2027-03-31")),
            tree = stream, defaults = JiraImportDefaults(programId = 7u, teamId = 10u),
        ).plan().row("200")
        assertEquals(JiraImportAction.BIND, bound.item.action, "the same name as an unbound sibling")
        assertNull(bound.window)
        assertNull(bound.item.startDate)
        val others = ImportCase(
            listOf(
                issue("100", JIRA_PROGRAM, "Program A", start = "2027-02-01", end = "2027-03-31"),
                issue("300", JIRA_EPIC, "Epic A", parent = "201", start = "2027-02-01", end = "2027-02-05"),
                issue("201", JIRA_PROJECT, "Initiative B", parent = "100", start = "2027-02-01", end = "2027-03-31"),
            ),
            tree = stream, defaults = JiraImportDefaults(teamId = 10u),
        ).plan()
        assertNull(others.row("100").window, "programs have no target window")
        assertNull(others.row("300").window, "a milestone's dates are its schedule")
        assertEquals(LocalDate.parse("2027-02-01"), others.row("201").window!!.start, "the project in the same batch has one")
    }
}
