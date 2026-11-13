package ch.nokillswit

import ch.nokillswit.jira.ImportApply
import ch.nokillswit.jira.ImportRootNode
import ch.nokillswit.jira.ImportTree
import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportParentKind
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraLevel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The root rule of the import kernel (1.15): an import started from a linked item writes only under that item, for every caller. The plan:
 * program 7 holds projects 7 and 9, program 8 holds project 8; Jira issue "100" is the root program's issue (held by program 7), "200" a
 * child project (held by whichever project a test picks) and "300" a milestone under it.
 */
class JiraImportRootKernelTest {
    private val tree = ImportTree(
        programs = listOf(node(7u, "Root program"), node(8u, "Other program")),
        projects = listOf(node(7u, "Own project", 7u), node(9u, "Second own project", 7u), node(8u, "Other project", 8u)),
        milestones = listOf(node(5u, "Item 301", 8u), node(6u, "Item 302", 7u)),
    )
    private val programRoot = ImportRootNode(JiraLevel.PROGRAM, 7u)
    private val projectRoot = ImportRootNode(JiraLevel.PROJECT, 7u)
    private val rootRow = holder("100", JiraLevel.PROGRAM, 7u, "Root program")
    private val defaults = JiraImportDefaults(teamId = PLATFORM.id)

    private fun issues(vararg milestones: String) = listOf(
        issue("100", JIRA_PROGRAM, "Root program"),
        issue("200", JIRA_PROJECT, "Child project", parent = "100"),
    ) + milestones.map { issue(it, JIRA_EPIC, "Item $it", parent = "200", team = "Platform") }

    private fun case(
        vararg milestones: String,
        heldBy: UInt,
        root: ImportRootNode? = programRoot,
        defaults: JiraImportDefaults = this.defaults,
    ) = ImportCase(
        issues(*milestones), tree = tree, holders = listOf(rootRow, holder("200", JiraLevel.PROJECT, heldBy, "Held project")),
        defaults = defaults, root = root,
    )

    @Test
    fun `what hangs under a child project linked to a project of ANOTHER program is OUTSIDE_ROOT under a program root`() {
        val plan = case("300", heldBy = 8u).plan()
        assertEquals(JiraImportReason.ALREADY_BOUND, plan.row("200").item.reason, "the child project itself is bound, naming its holder")
        val outside = plan.row("300").item
        assertEquals(listOf(JiraImportAction.SKIP, JiraImportReason.OUTSIDE_ROOT), listOf(outside.action, outside.reason))
        assertNull(outside.parent, "nothing lands anywhere")
    }

    @Test
    fun `a whole-scope import (no root) is the 1_14 row - created under the other program's project`() {
        val plan = case("300", heldBy = 8u, root = null).plan()
        val item = plan.row("300").item
        assertEquals(JiraImportAction.CREATE, item.action)
        assertEquals(listOf(JiraImportParentKind.EXISTING, 8u), listOf(item.parent!!.kind, item.parent.nodeId))
    }

    @Test
    fun `a milestone whose name equals an unlinked milestone of the other program's project is OUTSIDE_ROOT, not a BIND`() {
        // "Item 301" is an unlinked milestone of project 8: without a root it would be a BIND.
        val whole = case("301", heldBy = 8u, root = null).plan().row("301").item
        assertEquals(listOf(JiraImportAction.BIND, 5u), listOf(whole.action, whole.target!!.nodeId))
        val rooted = case("301", heldBy = 8u).plan().row("301").item
        assertEquals(listOf(JiraImportAction.SKIP, JiraImportReason.OUTSIDE_ROOT), listOf(rooted.action, rooted.reason))
        assertNull(rooted.target)
    }

    @Test
    fun `a holder under the root program still lands EXISTING, and a name there still binds`() {
        val plan = case("300", "302", heldBy = 9u).plan()
        val created = plan.row("300").item
        assertEquals(
            listOf(JiraImportAction.CREATE, JiraImportParentKind.EXISTING, 9u),
            listOf(created.action, created.parent!!.kind, created.parent.nodeId),
        )
        // "Item 302" is an unlinked milestone of project 7 (of the root program) but the issue sits under project 9: a plain create.
        assertEquals(JiraImportAction.CREATE, plan.row("302").item.action)
        val bind = case("302", heldBy = 7u).plan().row("302").item
        assertEquals(listOf(JiraImportAction.BIND, 6u), listOf(bind.action, bind.target!!.nodeId))
    }

    @Test
    fun `a holder in ANOTHER work stream keeps the default project, else NO_PARENT`() {
        val none = case("300", heldBy = 99u).plan().row("300").item
        assertEquals(JiraImportReason.NO_PARENT, none.reason)
        val withDefault = JiraImportDefaults(projectId = 9u, teamId = PLATFORM.id)
        val inRoot = case("300", heldBy = 99u, defaults = withDefault).plan().row("300").item
        assertEquals(
            listOf(JiraImportAction.CREATE, JiraImportParentKind.DEFAULT, 9u),
            listOf(inRoot.action, inRoot.parent!!.kind, inRoot.parent.nodeId),
        )
    }

    @Test
    fun `a default project outside the root handed straight to the kernel is OUTSIDE_ROOT`() {
        val orphan = ImportCase(
            listOf(issue("100", JIRA_PROGRAM, "Root program"), issue("303", JIRA_EPIC, "Orphan", team = "Platform")),
            tree = tree, holders = listOf(rootRow), defaults = JiraImportDefaults(projectId = 8u, teamId = PLATFORM.id), root = programRoot,
        ).plan()
        assertEquals(JiraImportReason.OUTSIDE_ROOT, orphan.row("303").item.reason)
        val inside = ImportCase(
            listOf(issue("100", JIRA_PROGRAM, "Root program"), issue("303", JIRA_EPIC, "Orphan", team = "Platform")),
            tree = tree, holders = listOf(rootRow), defaults = JiraImportDefaults(projectId = 9u, teamId = PLATFORM.id), root = programRoot,
        ).plan()
        assertEquals(JiraImportAction.CREATE, inside.row("303").item.action)
    }

    @Test
    fun `a project root never raises it for a milestone under the root project`() {
        val plan = ImportCase(
            listOf(issue("200", JIRA_PROJECT, "Root project"), issue("300", JIRA_EPIC, "Item 300", parent = "200", team = "Platform")),
            tree = tree, holders = listOf(holder("200", JiraLevel.PROJECT, 7u, "Own project")), root = projectRoot,
        ).plan()
        val item = plan.row("300").item
        assertEquals(listOf(JiraImportAction.CREATE, 7u), listOf(item.action, item.parent!!.nodeId))
        assertTrue(plan.rows.none { it.item.reason == JiraImportReason.OUTSIDE_ROOT })
    }

    @Test
    fun `an apply reports a ticked OUTSIDE_ROOT row with the kernel's reason, whatever the client expected`() {
        // The 1.14 client's tick: CREATE under the other program's project (what the whole-scope kernel showed).
        val seen = case("300", heldBy = 8u, root = null).plan()
        val stale = listOf(tick(seen.row("300")))
        val applied = case("300", heldBy = 8u).plan(stale)
        val row = applied.row("300")
        val apply = assertIs<ImportApply.Skipped>(row.apply)
        assertEquals(JiraImportReason.OUTSIDE_ROOT, apply.reason)
        assertTrue(applied.writes.isEmpty(), "nothing is written")
        assertEquals(JiraImportReason.OUTSIDE_ROOT, applied.skips.single { it.jiraId == "300" }.reason)
    }
}
