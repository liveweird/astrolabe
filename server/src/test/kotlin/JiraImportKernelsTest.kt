package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.jira.ImportApply
import ch.nokillswit.jira.ImportTeam
import ch.nokillswit.jira.ImportTree
import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportApplyItem
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportExpected
import ch.nokillswit.jira.JiraImportInfo
import ch.nokillswit.jira.JiraImportParentKind
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraImportTeamRule
import ch.nokillswit.jira.JiraEstimateUnit
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraMapping
import ch.nokillswit.jira.MAX_IMPORT_ITEMS
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Jira import kernel as pure vectors: one per row of the 1.2 plan's "hard cases" table (section 4), written from the rule, not from
 * the implementation. Issue ids: "1xx" programs, "2xx" projects (Initiatives), "3xx" milestones (Epics).
 */
class JiraImportKernelsTest {
    private val stream = ImportTree(
        programs = listOf(node(7u, "Platform program")),
        projects = listOf(node(7u, "Existing project", parentId = 7u), node(8u, "Other project", parentId = 7u)),
        milestones = listOf(node(7u, "Existing milestone", parentId = 7u)),
    )

    private fun fullTree() = listOf(
        issue("300", JIRA_EPIC, "Epic A", parent = "200"),
        issue("200", JIRA_PROJECT, "Initiative A", parent = "100"),
        issue("100", JIRA_PROGRAM, "Program A"),
        issue("301", JIRA_EPIC, "Epic B", parent = "200"),
        issue("201", JIRA_PROJECT, "Initiative B", parent = "100"),
        issue("302", JIRA_EPIC, "Epic C", parent = "201"),
    )

    // ---- A parent created in the same batch; ordering ---------------------------------------------------------------------------

    @Test
    fun `rows come top-down with ids ascending inside a level, numerically, and a new parent is the row that creates it`() {
        val preview = ImportCase(
            listOf(
                issue("10", JIRA_EPIC, parent = "200"), issue("9", JIRA_EPIC, parent = "200"), issue("200", JIRA_PROJECT, parent = "100"),
                issue("100", JIRA_PROGRAM), issue("201", JIRA_PROJECT, parent = "100"), issue("10000000000000000000", JIRA_EPIC),
            ),
        ).plan()
        assertEquals(listOf("100", "200", "201", "9", "10", "10000000000000000000"), preview.ids())
        assertEquals(
            listOf(JiraLevel.PROGRAM, JiraLevel.PROJECT, JiraLevel.PROJECT, JiraLevel.MILESTONE, JiraLevel.MILESTONE),
            preview.rows.take(5).map { it.item.level },
        )
        assertTrue(preview.rows.take(5).all { it.item.action == JiraImportAction.CREATE })
        assertNull(preview.row("100").item.parent, "a program lands in the picked stream")
        val project = preview.row("200").item.parent!!
        assertEquals(JiraImportParentKind.NEW_ROW, project.kind)
        assertEquals("100", project.rowJiraId)
        assertEquals("Item 100", project.nodeName)
        assertNull(project.nodeId)
        assertEquals("200", preview.row("9").item.parent!!.rowJiraId)
        assertTrue(preview.rows.all { it.apply == null }, "a preview ticks nothing")
        assertTrue(preview.rows.none { it.item.reason == JiraImportReason.CHANGED }, "CHANGED exists only in an apply")
        assertEquals(emptyList(), preview.skips.map { it.jiraId })
    }

    @Test
    fun `an issue repeated in the browse is one row`() {
        val preview = ImportCase(listOf(issue("100", JIRA_PROGRAM), issue("100", JIRA_PROGRAM))).plan()
        assertEquals(listOf("100"), preview.ids())
    }

    @Test
    fun `the totals count the rows by action`() {
        val case = ImportCase(fullTree() + issue("400", JIRA_EPIC, parent = "999"), defaults = JiraImportDefaults(teamId = 10u))
        val totals = case.plan().totals()
        assertEquals(7, totals.items)
        assertEquals(6, totals.create)
        assertEquals(0, totals.bind)
        assertEquals(1, totals.skip)
        assertFalse(totals.truncated)
    }

    // ---- The parent: bound ancestor, batch row, default, NO_PARENT -------------------------------------------------------------

    @Test
    fun `a bound ancestor under the stream is the parent, whichever connection holds the binding`() {
        for (connection in listOf(5u, 8u)) {
            val preview = ImportCase(
                listOf(issue("200", JIRA_PROJECT, "Bound initiative", parent = "100"), issue("300", JIRA_EPIC, parent = "200")),
                tree = stream,
                holders = listOf(holder("200", JiraLevel.PROJECT, 7u, "Existing project", connectionId = connection)),
            ).plan()
            val bound = preview.row("200").item
            assertEquals(JiraImportAction.SKIP, bound.action)
            assertEquals(JiraImportReason.ALREADY_BOUND, bound.reason)
            assertEquals(7u, bound.target!!.nodeId)
            assertEquals("Existing project", bound.target.nodeName)
            assertEquals(JiraLevel.PROJECT, bound.target.nodeKind)
            assertEquals(connection, bound.target.connectionId)
            val milestone = preview.row("300").item
            assertEquals(JiraImportAction.CREATE, milestone.action)
            assertEquals(JiraImportParentKind.EXISTING, milestone.parent!!.kind)
            assertEquals(7u, milestone.parent.nodeId)
            assertNull(milestone.parent.rowJiraId, "an already-bound parent depends on no row")
        }
    }

    @Test
    fun `a bound ancestor outside the stream is no parent, so the child falls to the default parent or has none`() {
        val outside = listOf(holder("200", JiraLevel.PROJECT, 99u, "Elsewhere"))
        val issues = listOf(issue("200", JIRA_PROJECT), issue("300", JIRA_EPIC, parent = "200"))
        val without = ImportCase(issues, tree = stream, holders = outside, defaults = JiraImportDefaults(teamId = 10u)).plan()
        assertEquals(JiraImportReason.NO_PARENT, without.row("300").item.reason)
        assertNull(without.row("300").item.parent)
        val with = ImportCase(issues, tree = stream, holders = outside, defaults = JiraImportDefaults(projectId = 8u, teamId = 10u)).plan()
        val parent = with.row("300").item.parent!!
        assertEquals(JiraImportParentKind.DEFAULT, parent.kind)
        assertEquals(8u, parent.nodeId)
        assertEquals("Other project", parent.nodeName)
    }

    @Test
    fun `a holder of another level, or a dead one, is not a usable parent`() {
        val issues = listOf(issue("200", JIRA_PROJECT, parent = "100"), issue("100", JIRA_PROGRAM), issue("300", JIRA_EPIC, parent = "200"))
        val wrongHolder = holder("200", JiraLevel.MILESTONE, 7u, "Existing milestone")
        val wrongLevel = ImportCase(issues, tree = stream, holders = listOf(wrongHolder)).plan()
        assertEquals(JiraImportAction.SKIP, wrongLevel.row("200").item.action, "any live holder still blocks the issue itself")
        assertEquals(JiraImportReason.NO_PARENT, wrongLevel.row("300").item.reason)
        val deadHolder = holder("200", JiraLevel.PROJECT, 7u, "Existing project", live = false)
        val dead = ImportCase(issues, tree = stream, holders = listOf(deadHolder)).plan()
        assertEquals(JiraImportAction.CREATE, dead.row("200").item.action)
        assertEquals(JiraImportParentKind.NEW_ROW, dead.row("300").item.parent!!.kind, "the new row, not the dead node")
        assertEquals("200", dead.row("300").item.parent!!.rowJiraId)
    }

    @Test
    fun `a BIND ancestor is an existing parent that still depends on its row`() {
        val preview = ImportCase(
            listOf(issue("200", JIRA_PROJECT, "EXISTING PROJECT"), issue("300", JIRA_EPIC, parent = "200")),
            tree = stream,
            defaults = JiraImportDefaults(programId = 7u, teamId = 10u),
        ).plan()
        assertEquals(JiraImportAction.BIND, preview.row("200").item.action)
        assertEquals(7u, preview.row("200").item.target!!.nodeId)
        assertEquals(JiraImportParentKind.DEFAULT, preview.row("200").item.parent!!.kind)
        val parent = preview.row("300").item.parent!!
        assertEquals(JiraImportParentKind.EXISTING, parent.kind)
        assertEquals(7u, parent.nodeId)
        assertEquals("200", parent.rowJiraId)
    }

    @Test
    fun `an orphan lands under the level's default parent, else it has no parent`() {
        val issues = listOf(issue("200", JIRA_PROJECT), issue("300", JIRA_EPIC, parent = "100"), issue("100", JIRA_PROGRAM))
        val none = ImportCase(issues, tree = stream).plan()
        assertEquals(JiraImportReason.NO_PARENT, none.row("200").item.reason)
        assertEquals(JiraImportReason.NO_PARENT, none.row("300").item.reason, "an epic straight under a program has no project to land in")
        val defaults = ImportCase(issues, tree = stream, defaults = JiraImportDefaults(programId = 7u, projectId = 7u, teamId = 10u)).plan()
        assertEquals(JiraImportParentKind.DEFAULT, defaults.row("200").item.parent!!.kind)
        assertEquals("Platform program", defaults.row("200").item.parent!!.nodeName)
        assertEquals(7u, defaults.row("300").item.parent!!.nodeId)
        val stale = JiraImportDefaults(programId = 55u, projectId = 56u, teamId = 10u)
        val unknown = ImportCase(issues, tree = stream, defaults = stale).plan()
        assertEquals(JiraImportReason.NO_PARENT, unknown.row("200").item.reason, "a default outside the stream is no default")
        assertEquals(JiraImportReason.NO_PARENT, unknown.row("300").item.reason)
    }

    @Test
    fun `a child of a browsed parent the kernel skipped is PARENT_SKIPPED, never re-homed under a default, and it cascades`() {
        val issues = listOf(
            issue("100", JIRA_PROGRAM, "Platform program"),
            issue("200", JIRA_PROJECT, parent = "100"),
            issue("300", JIRA_EPIC, parent = "200"),
        )
        val everyDefault = JiraImportDefaults(programId = 7u, projectId = 7u, teamId = 10u)
        val boundTree = ImportTree(listOf(node(7u, "Platform program", bound = true)), stream.projects, emptyList())
        val taken = ImportCase(issues, tree = boundTree, defaults = everyDefault).plan()
        assertEquals(JiraImportReason.NAME_TAKEN, taken.row("100").item.reason)
        assertEquals(JiraImportReason.PARENT_SKIPPED, taken.row("200").item.reason, "even with a default program")
        assertEquals(JiraImportReason.PARENT_SKIPPED, taken.row("300").item.reason, "the grandchild, even with a default project")
        assertNull(taken.row("300").item.parent)
        val bind = ImportCase(issues, tree = stream, defaults = everyDefault).plan()
        assertEquals(JiraImportAction.BIND, bind.row("100").item.action)
        assertEquals(JiraImportAction.CREATE, bind.row("200").item.action)
        val case = ImportCase(issues, tree = stream, defaults = everyDefault)
        val applied = case.applyAll("200")
        assertEquals(ImportApply.Write, applied.row("100").apply)
        assertEquals(ImportApply.NotRequested, applied.row("200").apply)
        val cascaded = applied.row("300").apply as ImportApply.Skipped
        assertEquals(JiraImportReason.PARENT_SKIPPED, cascaded.reason, "a ticked child of an unticked parent")
        val kernelSkipped = ImportCase(issues, tree = boundTree, defaults = everyDefault)
        val ticked = kernelSkipped.plan(listOf(tick(taken.row("200")), tick(taken.row("300"))))
        assertEquals(JiraImportReason.PARENT_SKIPPED, (ticked.row("300").apply as ImportApply.Skipped).reason)
    }

    @Test
    fun `a milestone under a project that has no parent is PARENT_SKIPPED, while an epic straight under a program is a genuine orphan`() {
        val issues = listOf(issue("100", JIRA_PROGRAM), issue("200", JIRA_PROJECT), issue("300", JIRA_EPIC, parent = "200"))
        val noParent = ImportCase(issues, tree = stream, defaults = JiraImportDefaults(projectId = 7u, teamId = 10u)).plan()
        assertEquals(JiraImportReason.NO_PARENT, noParent.row("200").item.reason)
        assertEquals(JiraImportReason.PARENT_SKIPPED, noParent.row("300").item.reason, "the default project does not catch it")
        val orphan = listOf(issue("100", JIRA_PROGRAM), issue("400", JIRA_EPIC, parent = "100"))
        val withDefault = ImportCase(orphan, tree = stream, defaults = JiraImportDefaults(projectId = 7u, teamId = 10u)).plan()
        assertEquals(JiraImportParentKind.DEFAULT, withDefault.row("400").item.parent!!.kind)
        val without = ImportCase(orphan, tree = stream).plan()
        assertEquals(JiraImportReason.NO_PARENT, without.row("400").item.reason)
    }

    // ---- The parent's level: discovery, the browsed set, the walk up ------------------------------------------------------------

    @Test
    fun `a parent outside the browse gets its level through the discovery by type id when its type object omits hierarchyLevel`() {
        val bound = listOf(holder("200", JiraLevel.PROJECT, 7u, "Existing project"))
        val initiative = issue("300", JIRA_EPIC, parent = "200", parentType = "10005")
        val byTypeId = ImportCase(listOf(initiative), tree = stream, holders = bound).plan()
        assertEquals(7u, byTypeId.row("300").item.parent!!.nodeId, "type 10005 is an Initiative: level 2, the project level")
        val level2 = issue("300", JIRA_EPIC, parent = "200", parentLevel = JIRA_PROJECT)
        val byLevel = ImportCase(listOf(level2), tree = stream, holders = bound).plan()
        assertEquals(7u, byLevel.row("300").item.parent!!.nodeId)
        val program = issue("300", JIRA_EPIC, parent = "200", parentType = "10006")
        val wrongType = ImportCase(listOf(program), tree = stream, holders = bound).plan()
        val unbound = ImportCase(listOf(initiative), tree = stream).plan()
        assertEquals(JiraImportReason.NO_PARENT, unbound.row("300").item.reason, "an Initiative that nothing binds is no parent either")
        assertEquals(JiraImportReason.NO_PARENT, wrongType.row("300").item.reason, "a Program is not the project level")
    }

    @Test
    fun `a parent outside the browse with an unknown level is no ancestor at all`() {
        val bound = listOf(holder("200", JiraLevel.PROJECT, 7u, "Existing project"))
        for (parent in listOf(issue("300", JIRA_EPIC, parent = "200"), issue("300", JIRA_EPIC, parent = "200", parentType = "99999"))) {
            val none = ImportCase(listOf(parent), tree = stream, holders = bound).plan()
            assertEquals(JiraImportReason.NO_PARENT, none.row("300").item.reason)
            val withDefault = JiraImportDefaults(projectId = 8u, teamId = 10u)
            val defaulted = ImportCase(listOf(parent), tree = stream, holders = bound, defaults = withDefault).plan()
            assertEquals(JiraImportParentKind.DEFAULT, defaulted.row("300").item.parent!!.kind)
        }
    }

    @Test
    fun `a browsed parent is read from its own observation before the type on its child`() {
        val issues = listOf(
            issue("200", JIRA_PROJECT, parent = "100"),
            issue("100", JIRA_PROGRAM),
            issue("300", JIRA_EPIC, parent = "200", parentLevel = JIRA_PROGRAM, parentType = "10006"),
        )
        assertEquals("200", ImportCase(issues).plan().row("300").item.parent!!.rowJiraId)
    }

    @Test
    fun `a browsed parent whose own level is unknown falls back to the type on its child`() {
        val issues = listOf(
            issue("200", null, parent = "100"),
            issue("300", JIRA_EPIC, parent = "200", parentLevel = JIRA_PROJECT),
        )
        val preview = ImportCase(issues, defaults = JiraImportDefaults(projectId = 8u, teamId = 10u), tree = stream).plan()
        assertEquals(JiraImportReason.LEVEL_UNMAPPED, preview.row("200").item.reason)
        assertEquals(JiraImportReason.PARENT_SKIPPED, preview.row("300").item.reason, "its project-level parent is in the browse, skipped")
    }

    @Test
    fun `a level the mapping skips is never walked through - the child of an unbrowsed intermediary is a genuine orphan`() {
        val issues = listOf(
            issue("100", JIRA_PROGRAM),
            issue("200", JIRA_PROJECT, parent = "100"),
            issue("300", JIRA_EPIC, parent = "250", parentType = "10001"),
        )
        val none = ImportCase(issues).plan()
        assertEquals(JiraImportReason.NO_PARENT, none.row("300").item.reason, "the Story is not in the browse: its parent is out of sight")
        val defaulted = ImportCase(issues, tree = stream, defaults = JiraImportDefaults(projectId = 7u, teamId = 10u)).plan()
        assertEquals(JiraImportParentKind.DEFAULT, defaulted.row("300").item.parent!!.kind)
        val viaProgram = ImportCase(listOf(issue("100", JIRA_PROGRAM), issue("300", JIRA_EPIC, parent = "100"))).plan()
        assertEquals(JiraImportReason.NO_PARENT, viaProgram.row("300").item.reason, "only the direct parent is read")
    }

    @Test
    fun `a self-parent or a cycle never loops, each issue being a genuine orphan`() {
        val epics = ImportCase(
            listOf(
                issue("300", JIRA_EPIC, parent = "300"),
                issue("301", JIRA_EPIC, parent = "302"),
                issue("302", JIRA_EPIC, parent = "301"),
            ),
        )
        assertEquals(List(3) { JiraImportReason.NO_PARENT }, epics.plan().rows.map { it.item.reason })
        val projectCycle = listOf(
            issue("200", JIRA_PROJECT, parent = "200"),
            issue("201", JIRA_PROJECT, parent = "202"),
            issue("202", JIRA_PROJECT, parent = "201"),
        )
        val projects = ImportCase(
            projectCycle,
        )
        assertEquals(List(3) { JiraImportReason.NO_PARENT }, projects.plan().rows.map { it.item.reason })
        val sameWithDefault = ImportCase(
            projectCycle,
            tree = stream,
            defaults = JiraImportDefaults(programId = 7u),
        ).plan()
        assertTrue(sameWithDefault.rows.all { it.item.parent!!.kind == JiraImportParentKind.DEFAULT })
    }

    @Test
    fun `a browsed parent of unknown level is PARENT_SKIPPED whatever the order of the ids`() {
        for ((parentId, childId) in listOf("200" to "300", "300" to "200")) {
            val preview = ImportCase(
                listOf(issue(parentId, null, parent = "100"), issue(childId, JIRA_EPIC, parent = parentId, parentLevel = JIRA_PROJECT)),
                tree = stream,
                defaults = JiraImportDefaults(projectId = 8u, teamId = 10u),
            ).plan()
            assertEquals(JiraImportReason.LEVEL_UNMAPPED, preview.row(parentId).item.reason, "parent $parentId")
            assertEquals(JiraImportReason.PARENT_SKIPPED, preview.row(childId).item.reason, "child $childId")
        }
    }

    @Test
    fun `node ids of different levels overlap without sharing a name space`() {
        val tree = ImportTree(listOf(node(3u, "Some program")), listOf(node(3u, "Some project", parentId = 3u)), emptyList())
        val preview = ImportCase(
            listOf(issue("200", JIRA_PROJECT, "Alpha"), issue("300", JIRA_EPIC, "Alpha")),
            tree = tree,
            defaults = JiraImportDefaults(programId = 3u, projectId = 3u, teamId = 10u),
        ).plan()
        assertEquals(3u, preview.row("200").item.parent!!.nodeId)
        assertEquals(3u, preview.row("300").item.parent!!.nodeId)
        assertEquals(JiraImportAction.CREATE, preview.row("200").item.action)
        assertEquals(JiraImportAction.CREATE, preview.row("300").item.action, "program 3's initiative does not take it")
        val twice = ImportCase(
            listOf(issue("201", JIRA_PROJECT, "Beta"), issue("202", JIRA_PROJECT, "beta")), tree = tree,
            defaults = JiraImportDefaults(programId = 3u),
        ).plan()
        assertEquals(JiraImportReason.NAME_TAKEN, twice.row("202").item.reason, "the same level and parent still collide")
    }

    @Test
    fun `with no project level mapped a milestone still needs a project, only the default can give one`() {
        val mapping = importMapping(project = false)
        val issues = listOf(issue("100", JIRA_PROGRAM), issue("300", JIRA_EPIC, parent = "100"), issue("200", JIRA_PROJECT, parent = "100"))
        val none = ImportCase(issues, mapping = mapping, tree = stream).plan()
        assertEquals(JiraImportReason.LEVEL_UNMAPPED, none.row("200").item.reason)
        assertEquals(JiraImportReason.NO_PARENT, none.row("300").item.reason)
        val withProject = JiraImportDefaults(projectId = 7u, teamId = 10u)
        val defaulted = ImportCase(issues, mapping = mapping, tree = stream, defaults = withProject).plan()
        assertEquals(7u, defaulted.row("300").item.parent!!.nodeId)
    }

    @Test
    fun `with no program level mapped a project still needs a program`() {
        val mapping = importMapping(program = false)
        val issues = listOf(issue("100", JIRA_PROGRAM), issue("200", JIRA_PROJECT, parent = "100"))
        val preview = ImportCase(issues, mapping = mapping, tree = stream, defaults = JiraImportDefaults(programId = 7u)).plan()
        assertEquals(JiraImportReason.LEVEL_UNMAPPED, preview.row("100").item.reason)
        assertEquals(7u, preview.row("200").item.parent!!.nodeId)
    }

    // ---- LEVEL_UNMAPPED ---------------------------------------------------------------------------------------------------------

    @Test
    fun `an unmapped level is skipped, keeps the nearest mapped level and sorts there`() {
        val preview = ImportCase(
            listOf(
                issue("500", JIRA_STORY), issue("501", 5), issue("502", null), issue("100", JIRA_PROGRAM), issue("200", JIRA_PROJECT),
            ),
            tree = stream,
        ).plan()
        assertEquals(listOf("100", "501", "200", "500", "502"), preview.ids())
        assertEquals(JiraLevel.PROGRAM, preview.row("501").item.level, "5 is nearest to 3")
        assertEquals(JiraLevel.MILESTONE, preview.row("500").item.level, "0 is nearest to 1")
        assertEquals(JiraLevel.MILESTONE, preview.row("502").item.level, "no level at all reads as the milestone side")
        assertTrue(listOf("501", "500", "502").all { preview.row(it).item.reason == JiraImportReason.LEVEL_UNMAPPED })
        assertTrue(listOf("501", "500", "502").all { preview.row(it).item.action == JiraImportAction.SKIP })
        val tie = ImportCase(listOf(issue("600", JIRA_PROJECT)), mapping = importMapping(project = false)).plan()
        assertEquals(JiraLevel.MILESTONE, tie.row("600").item.level, "equally near the program (3) and the milestone (1): the deeper one")
    }

    // ---- PARENT_SKIPPED / ticks -------------------------------------------------------------------------------------------------

    @Test
    fun `an unticked parent skips its children and grandchildren, never re-homing them`() {
        val case = ImportCase(fullTree(), defaults = JiraImportDefaults(programId = 7u, projectId = 7u, teamId = 10u), tree = stream)
        val untickedProgram = case.applyAll("100")
        assertEquals(ImportApply.NotRequested, untickedProgram.row("100").apply)
        for (id in listOf("200", "201")) assertIs<ImportApply.Skipped>(untickedProgram.row(id).apply)
        for (id in listOf("200", "201", "300", "301", "302")) {
            assertEquals(JiraImportReason.PARENT_SKIPPED, (untickedProgram.row(id).apply as ImportApply.Skipped).reason, id)
        }
        assertTrue(untickedProgram.writes.isEmpty())
        assertEquals(listOf("200", "201", "300", "301", "302"), untickedProgram.skips.map { it.jiraId })
        assertEquals(setOf(JiraImportReason.PARENT_SKIPPED), untickedProgram.skips.map { it.reason }.toSet())
        assertEquals("IMP-300", untickedProgram.skips.first { it.jiraId == "300" }.issueKey)
    }

    @Test
    fun `unticking one project skips only its own subtree`() {
        val applied = ImportCase(fullTree()).applyAll("200")
        assertEquals(listOf("100", "201", "302"), applied.writes.map { it.item.jiraId })
        assertEquals(listOf("300", "301"), applied.skips.map { it.jiraId })
        assertEquals(ImportApply.NotRequested, applied.row("200").apply)
    }

    @Test
    fun `an unticked BIND parent skips its children too`() {
        val case = ImportCase(
            listOf(issue("200", JIRA_PROJECT, "existing project"), issue("300", JIRA_EPIC, parent = "200")),
            tree = stream,
            defaults = JiraImportDefaults(programId = 7u, teamId = 10u),
        )
        val applied = case.applyAll("200")
        assertEquals(JiraImportReason.PARENT_SKIPPED, (applied.row("300").apply as ImportApply.Skipped).reason)
        assertEquals(listOf("200", "300"), case.applyAll().writes.map { it.item.jiraId })
    }

    @Test
    fun `a parent row that is already bound is a usable parent and needs no tick`() {
        val case = ImportCase(
            listOf(issue("200", JIRA_PROJECT), issue("300", JIRA_EPIC, parent = "200")),
            tree = stream,
            holders = listOf(holder("200", JiraLevel.PROJECT, 7u, "Existing project")),
        )
        val applied = case.applyAll()
        assertEquals(listOf("300"), applied.writes.map { it.item.jiraId })
        assertEquals(ImportApply.NotRequested, applied.row("200").apply)
    }

    @Test
    fun `an apply writes in preview order and reports nothing for rows nobody ticked`() {
        val applied = ImportCase(fullTree()).applyAll("302")
        assertEquals(listOf("100", "200", "201", "300", "301"), applied.writes.map { it.item.jiraId })
        assertEquals(ImportApply.NotRequested, applied.row("302").apply)
        assertTrue(applied.skips.isEmpty())
        assertTrue(applied.vanished.isEmpty())
    }

    // ---- CHANGED, and a ticked row the kernel skips -----------------------------------------------------------------------------

    private fun changedBy(case: ImportCase, id: String, expected: (JiraImportExpected) -> JiraImportExpected): JiraImportReason? {
        val preview = case.plan()
        val ticks = tickable(preview).map { if (it.jiraId == id) JiraImportApplyItem(id, expected(it.expected), it.overrides) else it }
        return (case.plan(ticks).row(id).apply as? ImportApply.Skipped)?.reason
    }

    @Test
    fun `a ticked row is CHANGED when any field of what the client saw differs`() {
        val case = ImportCase(
            listOf(issue("200", JIRA_PROJECT, "existing project"), issue("300", JIRA_EPIC, parent = "200")),
            tree = stream,
            defaults = JiraImportDefaults(programId = 7u, teamId = 10u),
        )
        assertEquals(JiraImportAction.BIND, case.plan().row("200").item.action)
        assertEquals(JiraImportReason.CHANGED, changedBy(case, "300") { it.copy(action = JiraImportAction.BIND, nodeId = 7u) }, "action")
        val toCreate = changedBy(case, "200") { it.copy(action = JiraImportAction.CREATE, nodeId = null) }
        assertEquals(JiraImportReason.CHANGED, toCreate, "action, the other way")
        assertEquals(JiraImportReason.CHANGED, changedBy(case, "300") { it.copy(level = JiraLevel.PROJECT) }, "level")
        assertEquals(JiraImportReason.CHANGED, changedBy(case, "300") { it.copy(parentJiraId = "201") }, "Jira parent")
        assertEquals(JiraImportReason.CHANGED, changedBy(case, "300") { it.copy(parentJiraId = null) }, "Jira parent gone")
        assertEquals(JiraImportReason.CHANGED, changedBy(case, "200") { it.copy(nodeId = 8u) }, "BIND target node")
        assertEquals(JiraImportReason.CHANGED, changedBy(case, "300") { it.copy(nodeId = 7u) }, "a node on a CREATE")
        assertNull(changedBy(case, "300") { it }, "unchanged is written")
    }

    @Test
    fun `an id the browse no longer holds is CHANGED without a key`() {
        val case = ImportCase(listOf(issue("100", JIRA_PROGRAM)))
        val ticks = tickable(case.plan()) + JiraImportApplyItem("777", JiraImportExpected(JiraImportAction.CREATE, JiraLevel.PROGRAM))
        val applied = case.plan(ticks)
        assertEquals(listOf("777"), applied.vanished)
        val skip = applied.skips.single()
        assertEquals("777", skip.jiraId)
        assertNull(skip.issueKey)
        assertEquals(JiraImportReason.CHANGED, skip.reason)
        assertEquals(listOf("100"), applied.writes.map { it.item.jiraId })
    }

    @Test
    fun `a ticked row the kernel itself skips is reported with the kernel's reason, so a re-import answers ALREADY_BOUND`() {
        val case = ImportCase(
            listOf(issue("100", JIRA_PROGRAM), issue("200", JIRA_PROJECT, parent = "100")),
            holders = listOf(
                holder("100", JiraLevel.PROGRAM, 7u, "Platform program"),
                holder("200", JiraLevel.PROJECT, 7u, "Existing project"),
            ),
            tree = stream,
        )
        val ticks = listOf(
            JiraImportApplyItem("100", JiraImportExpected(JiraImportAction.CREATE, JiraLevel.PROGRAM)),
            JiraImportApplyItem("200", JiraImportExpected(JiraImportAction.CREATE, JiraLevel.PROJECT, "100")),
        )
        val applied = case.plan(ticks)
        assertEquals(listOf(JiraImportReason.ALREADY_BOUND, JiraImportReason.ALREADY_BOUND), applied.skips.map { it.reason })
        assertTrue(applied.writes.isEmpty())
    }

    @Test
    fun `an apply sees a plan that moved - a deleted BIND target is now a CREATE and a bound one is taken`() {
        val issues = listOf(issue("200", JIRA_PROJECT, "existing project", parent = "100"), issue("100", JIRA_PROGRAM, "Platform program"))
        val shown = ImportCase(issues, tree = stream).plan()
        val ticks = tickable(shown)
        val deleted = ImportCase(issues, tree = ImportTree(stream.programs, emptyList(), emptyList())).plan(ticks)
        assertEquals(JiraImportReason.CHANGED, (deleted.row("200").apply as ImportApply.Skipped).reason)
        val boundTree = ImportTree(stream.programs, listOf(node(7u, "Existing project", 7u, bound = true)), emptyList())
        val bound = ImportCase(issues, tree = boundTree).plan(ticks)
        assertEquals(JiraImportReason.NAME_TAKEN, (bound.row("200").apply as ImportApply.Skipped).reason)
    }

    // ---- Names: truncation, case-insensitive BIND vs NAME_TAKEN -----------------------------------------------------------------

    @Test
    fun `two 110-character siblings sharing their first 100 characters - the first is created, the second is taken`() {
        val common = "x".repeat(100)
        val preview = ImportCase(
            listOf(
                issue("100", JIRA_PROGRAM),
                issue("200", JIRA_PROJECT, common + "AAAAAAAAAA", parent = "100"),
                issue("201", JIRA_PROJECT, common + "BBBBBBBBBB", parent = "100"),
            ),
        ).plan()
        assertEquals(JiraImportAction.CREATE, preview.row("200").item.action)
        assertEquals(common, preview.row("200").item.name)
        assertEquals(listOf(JiraImportInfo.NAME_TRUNCATED), preview.row("200").item.infos)
        assertEquals(110, preview.row("200").item.summary.length)
        assertEquals(JiraImportReason.NAME_TAKEN, preview.row("201").item.reason)
        assertEquals(listOf(JiraImportInfo.NAME_TRUNCATED), preview.row("201").item.infos)
    }

    @Test
    fun `the same name under different parents does not collide`() {
        val preview = ImportCase(
            listOf(
                issue("100", JIRA_PROGRAM, "A"), issue("101", JIRA_PROGRAM, "B"),
                issue("200", JIRA_PROJECT, "Same", parent = "100"), issue("201", JIRA_PROJECT, "same", parent = "101"),
            ),
        ).plan()
        assertEquals(JiraImportAction.CREATE, preview.row("200").item.action)
        assertEquals(JiraImportAction.CREATE, preview.row("201").item.action)
    }

    @Test
    fun `an unbound sibling of the same name in any case is bound, a bound one is taken`() {
        val tree = ImportTree(
            programs = listOf(node(7u, "Platform program"), node(2u, "Bound program", bound = true)),
            projects = listOf(node(7u, "Existing Project", 7u), node(8u, "Bound project", 7u, bound = true)),
            milestones = listOf(node(7u, "EXISTING MILESTONE", 7u), node(71u, "Bound milestone", 7u, bound = true)),
        )
        val preview = ImportCase(
            listOf(
                issue("100", JIRA_PROGRAM, "platform PROGRAM"), issue("101", JIRA_PROGRAM, "bound program"),
                issue("200", JIRA_PROJECT, "existing project", parent = "100"), issue("201", JIRA_PROJECT, "BOUND PROJECT", parent = "100"),
                issue("300", JIRA_EPIC, "Existing milestone", parent = "200"), issue("301", JIRA_EPIC, "bound milestone", parent = "200"),
            ),
            tree = tree,
        ).plan()
        assertEquals(listOf(7u, 7u, 7u), listOf("100", "200", "300").map { preview.row(it).item.target!!.nodeId })
        val names = listOf("100", "200", "300").map { preview.row(it).item.target!!.nodeName }
        assertEquals(listOf("Platform program", "Existing Project", "EXISTING MILESTONE"), names)
        val taken = listOf("101", "201", "301").map { preview.row(it).item.reason }
        assertEquals(List(3) { JiraImportReason.NAME_TAKEN }, taken)
    }

    @Test
    fun `a program name taken under another stream is taken, an unbound one in this stream is bound`() {
        val preview = ImportCase(
            listOf(issue("100", JIRA_PROGRAM, "Other Stream Program"), issue("101", JIRA_PROGRAM, "Platform program")),
            tree = stream,
            programNames = listOf("Platform program", "other stream program"),
        ).plan()
        assertEquals(JiraImportReason.NAME_TAKEN, preview.row("100").item.reason)
        assertEquals(JiraImportAction.BIND, preview.row("101").item.action)
    }

    @Test
    fun `an earlier batch row claims its name - a CREATE for a new one, a BIND for an existing node`() {
        val preview = ImportCase(
            listOf(
                issue("100", JIRA_PROGRAM, "Fresh"), issue("101", JIRA_PROGRAM, "FRESH"),
                issue("200", JIRA_PROJECT, "Existing project", parent = "100"),
                issue("201", JIRA_PROJECT, "existing project", parent = "100"),
            ),
            tree = stream,
        ).plan()
        assertEquals(JiraImportAction.CREATE, preview.row("100").item.action)
        assertEquals(JiraImportReason.NAME_TAKEN, preview.row("101").item.reason)
        assertEquals(JiraImportAction.CREATE, preview.row("200").item.action, "a new program has no existing sibling to bind")
        assertEquals(JiraImportReason.NAME_TAKEN, preview.row("201").item.reason)
        val bind = ImportCase(
            listOf(issue("200", JIRA_PROJECT, "Existing project"), issue("201", JIRA_PROJECT, "existing PROJECT")),
            tree = stream,
            defaults = JiraImportDefaults(programId = 7u, teamId = 10u),
        ).plan()
        assertEquals(JiraImportAction.BIND, bind.row("200").item.action)
        assertEquals(JiraImportReason.NAME_TAKEN, bind.row("201").item.reason, "the node is already claimed by the first row")
    }

    @Test
    fun `a row skipped for another reason claims no name`() {
        val preview = ImportCase(
            listOf(
                issue("100", JIRA_PROGRAM), issue("200", JIRA_PROJECT, parent = "100"),
                issue("300", JIRA_EPIC, "Twin", parent = "200", team = "Nobody"),
                issue("301", JIRA_EPIC, "twin", parent = "200", team = "Platform"),
            ),
            defaults = JiraImportDefaults(),
        ).plan()
        assertEquals(JiraImportReason.NO_TEAM, preview.row("300").item.reason)
        assertEquals(JiraImportAction.CREATE, preview.row("301").item.action)
    }

    // ---- Bindings: this connection, D1, dead holders ----------------------------------------------------------------------------

    @Test
    fun `an issue with a live binding is ALREADY_BOUND whichever connection holds it, and a dead holder is released`() {
        val preview = ImportCase(
            listOf(issue("100", JIRA_PROGRAM), issue("102", JIRA_PROGRAM)),
            tree = stream,
            holders = listOf(
                holder("100", JiraLevel.PROGRAM, 7u, "Platform program", connectionId = 5u),
                holder("102", JiraLevel.PROGRAM, 2u, "Site twin", connectionId = 6u),
            ),
        ).plan()
        assertEquals(JiraImportReason.ALREADY_BOUND, preview.row("100").item.reason)
        assertEquals(5u, preview.row("100").item.target!!.connectionId)
        assertEquals(6u, preview.row("102").item.target!!.connectionId)
        assertEquals(JiraImportReason.ALREADY_BOUND, preview.row("102").item.reason)
        assertTrue(preview.row("100").releases.isEmpty())
    }

    @Test
    fun `a dead holder never blocks - the row is created or bound and carries the release`() {
        val dead = holder("100", JiraLevel.PROGRAM, 9u, "Deleted program", live = false, bindingId = 31u)
        val deadToo = holder("101", JiraLevel.PROGRAM, 3u, "Gone", live = false, connectionId = 6u, bindingId = 32u)
        val preview = ImportCase(
            listOf(issue("100", JIRA_PROGRAM, "Platform program"), issue("101", JIRA_PROGRAM, "Brand new")),
            tree = stream,
            holders = listOf(dead, deadToo),
        ).plan()
        assertEquals(JiraImportAction.BIND, preview.row("100").item.action)
        assertEquals(listOf(31u), preview.row("100").releases.map { it.bindingId })
        assertEquals(JiraImportAction.CREATE, preview.row("101").item.action)
        assertEquals(listOf(32u), preview.row("101").releases.map { it.bindingId })
        val live = holder("101", JiraLevel.PROGRAM, 4u, "Live", bindingId = 33u)
        val both = ImportCase(listOf(issue("101", JIRA_PROGRAM)), holders = listOf(deadToo, live)).plan().row("101").item
        assertEquals(JiraImportReason.ALREADY_BOUND, both.reason)
        assertEquals(4u, both.target!!.nodeId, "the live holder is the one named")
    }

    // ---- Teams ------------------------------------------------------------------------------------------------------------------

    @Test
    fun `a team is matched by a fold - case, accents and the letters with no decomposition`() {
        val preview = ImportCase(
            listOf(
                issue("300", JIRA_EPIC, "Pay", team = "  zespol PLATNOSCI "),
                issue("301", JIRA_EPIC, "Pay 2", team = "Zespół Płatności"),
            ),
            teams = listOf(PLATFORM, ImportTeam(20u, "Zespół Płatności")),
            tree = stream,
            defaults = JiraImportDefaults(projectId = 7u),
        ).plan()
        for (id in listOf("300", "301")) {
            val team = preview.row(id).item.team!!
            assertEquals(20u, team.id, id)
            assertEquals("Zespół Płatności", team.name)
            assertEquals(JiraImportTeamRule.MATCHED, team.rule)
        }
        assertTrue(preview.unmatchedTeams.isEmpty())
    }

    @Test
    fun `without a name match the default team is used, and without a default the row has no team`() {
        val issues = listOf(
            issue("300", JIRA_EPIC, "A", team = "Unknown crew"),
            issue("301", JIRA_EPIC, "B"),
            issue("302", JIRA_EPIC, "C", team = "   "),
        )
        val withDefault = ImportCase(issues, tree = stream, defaults = JiraImportDefaults(projectId = 7u, teamId = 10u)).plan()
        for (id in listOf("300", "301", "302")) {
            assertEquals(JiraImportTeamRule.DEFAULT, withDefault.row(id).item.team!!.rule, id)
            assertEquals(10u, withDefault.row(id).item.team!!.id)
        }
        assertEquals(listOf("Unknown crew"), withDefault.unmatchedTeams, "a default still leaves the name unmatched; a blank is not a name")
        val without = ImportCase(issues, tree = stream, defaults = JiraImportDefaults(projectId = 7u)).plan()
        assertTrue(without.rows.all { it.item.reason == JiraImportReason.NO_TEAM && it.item.action == JiraImportAction.SKIP })
        assertEquals(listOf("Unknown crew"), without.unmatchedTeams)
        val staleDefault = ImportCase(issues, tree = stream, defaults = JiraImportDefaults(projectId = 7u, teamId = 99u)).plan()
        assertEquals(JiraImportReason.NO_TEAM, staleDefault.row("301").item.reason, "an inactive default team is no team")
    }

    @Test
    fun `unmatched team names are distinct and sorted, and two teams that fold alike resolve to the lowest id`() {
        val preview = ImportCase(
            listOf(
                issue("300", JIRA_EPIC, "A", team = "Zulu"),
                issue("301", JIRA_EPIC, "B", team = "Alpha"),
                issue("302", JIRA_EPIC, "C", team = "Zulu"),
                issue("303", JIRA_EPIC, "D", team = "crew"),
                issue("304", JIRA_EPIC, "E", team = "zulu"),
            ),
            teams = listOf(ImportTeam(31u, "CREW"), ImportTeam(30u, "Crew")),
            tree = stream,
            defaults = JiraImportDefaults(projectId = 7u),
        ).plan()
        assertEquals(listOf("Alpha", "Zulu"), preview.unmatchedTeams)
        assertEquals(30u, preview.row("303").item.team!!.id)
    }

    @Test
    fun `an apply override wins over the match, and an unknown one is NO_TEAM rather than another team`() {
        val case = ImportCase(
            listOf(issue("300", JIRA_EPIC, "A", team = "Platform"), issue("301", JIRA_EPIC, "B", team = "Platform")),
            teams = listOf(PLATFORM, ImportTeam(20u, "Other")),
            tree = stream,
            defaults = JiraImportDefaults(projectId = 7u),
        )
        val preview = case.plan()
        assertEquals(10u, preview.row("300").item.team!!.id)
        val ticks = listOf(tick(preview.row("300"), teamOverride = 20u), tick(preview.row("301"), teamOverride = 99u))
        val applied = case.plan(ticks)
        assertEquals(20u, applied.row("300").item.team!!.id)
        assertEquals(JiraImportTeamRule.DEFAULT, applied.row("300").item.team!!.rule)
        assertEquals(ImportApply.Write, applied.row("300").apply)
        assertEquals(JiraImportReason.NO_TEAM, (applied.row("301").apply as ImportApply.Skipped).reason)
    }

    // ---- Estimates and dates on the rows ----------------------------------------------------------------------------------------

    private fun milestone(
        estimate: String? = null,
        start: String? = null,
        end: String? = null,
        team: String? = null,
        canSchedule: Set<UInt>? = null,
        calendar: WorkingCalendar = WorkingCalendar.MON_FRI,
        copyDates: Boolean = true,
        mapping: JiraMapping = importMapping(),
        teams: List<ImportTeam> = listOf(PLATFORM),
    ) = ImportCase(
        listOf(issue("300", JIRA_EPIC, "M", team = team, start = start, end = end, estimate = estimate)),
        teams = teams, tree = stream, defaults = JiraImportDefaults(projectId = 7u, teamId = 10u), canSchedule = canSchedule,
        calendar = calendar, copyDates = copyDates, mapping = mapping,
    ).plan().row("300")

    /** A milestone with valid dates, so its infos speak of the estimate only. */
    private fun dated(estimate: String? = null, mapping: JiraMapping = importMapping()) =
        milestone(estimate = estimate, start = MONDAY, end = MONDAY, mapping = mapping)

    @Test
    fun `a row carries the converted estimate - a factor, DAYS, none declared, none at all, out of range`() {
        assertEquals("2.50", dated(estimate = "5").estimate!!.toPlainString())
        assertEquals(2.5, dated(estimate = "5").item.estimateMd)
        assertTrue(dated(estimate = "5").item.infos.isEmpty())
        assertEquals("7.00", dated(estimate = "7", mapping = importMapping(JiraEstimateUnit.DAYS, factor = 8.0)).estimate!!.toPlainString())
        val undeclared = dated(estimate = "5", mapping = importMapping(factor = null))
        assertEquals("0.00", undeclared.estimate!!.toPlainString())
        assertEquals(listOf(JiraImportInfo.ESTIMATE_NOT_CONVERTED), undeclared.item.infos)
        val none = dated()
        assertEquals("0.00", none.estimate!!.toPlainString())
        assertTrue(none.item.infos.isEmpty(), "nothing to convert is nothing to report")
        assertEquals(listOf(JiraImportInfo.ESTIMATE_NOT_CONVERTED), dated(estimate = "3000000").item.infos)
        assertEquals("0.00", dated(estimate = "-4").estimate!!.toPlainString())
        assertEquals("0.01", dated(estimate = "0.01", mapping = importMapping(JiraEstimateUnit.DAYS)).estimate!!.toPlainString())
    }

    @Test
    fun `complete dates are copied for an admin and for the team's manager, and scheduled is what will happen`() {
        val admin = milestone(start = MONDAY, end = "2027-02-03")
        assertEquals(LocalDate.parse(MONDAY), admin.span!!.start)
        assertEquals(LocalDate.parse("2027-02-03"), admin.span.end)
        assertTrue(admin.item.scheduled)
        assertTrue(admin.item.canSchedule)
        assertEquals(MONDAY, admin.item.startDate)
        assertEquals("2027-02-03", admin.item.endDate)
        assertTrue(admin.item.infos.isEmpty())
        val manager = milestone(start = MONDAY, end = MONDAY, canSchedule = setOf(10u))
        assertTrue(manager.item.scheduled)
        assertTrue(manager.item.canSchedule)
    }

    @Test
    fun `a caller who does not manage the team still creates the milestone, unscheduled, with DATES_NOT_COPIED`() {
        val row = milestone(start = MONDAY, end = "2027-02-03", canSchedule = setOf(99u))
        assertEquals(JiraImportAction.CREATE, row.item.action)
        assertFalse(row.item.canSchedule)
        assertFalse(row.item.scheduled)
        assertNull(row.span)
        assertEquals(listOf(JiraImportInfo.DATES_NOT_COPIED), row.item.infos)
        assertEquals(MONDAY, row.item.startDate, "Jira's dates stay visible")
        assertFalse(milestone(start = MONDAY, end = MONDAY, canSchedule = emptySet()).item.canSchedule)
    }

    @Test
    fun `dates that are one-sided, reversed or outside 1900-2999 are invalid and leave the milestone unscheduled`() {
        val invalid = listOf(MONDAY to null, null to MONDAY, "2027-02-03" to MONDAY, MONDAY to "3000-01-01", "1899-12-31" to MONDAY)
        for ((start, end) in invalid) {
            val row = milestone(start = start, end = end)
            assertEquals(JiraImportAction.CREATE, row.item.action, "$start..$end")
            assertFalse(row.item.scheduled, "$start..$end")
            assertEquals(listOf(JiraImportInfo.DATES_INVALID), row.item.infos, "$start..$end")
        }
        assertTrue(milestone(start = "2999-12-24", end = "2999-12-31").item.scheduled, "the last plan year is valid")
        assertTrue(milestone(start = "1900-01-01", end = "1900-01-08").item.scheduled, "the first plan year is valid")
    }

    @Test
    fun `an undated milestone reads DATES_INVALID, unless the mapping reads no date field at all`() {
        assertEquals(listOf(JiraImportInfo.DATES_INVALID), milestone().item.infos)
        assertTrue(milestone(mapping = importMapping(dateFields = false)).item.infos.isEmpty())
    }

    @Test
    fun `a span with no working day is created unscheduled with NO_WORKING_DAY`() {
        val holiday = WorkingCalendar(mapOf(LocalDate.parse(MONDAY) to "Holiday"))
        val onlyHoliday = milestone(start = MONDAY, end = MONDAY, calendar = holiday)
        assertEquals(JiraImportAction.CREATE, onlyHoliday.item.action)
        assertFalse(onlyHoliday.item.scheduled)
        assertEquals(listOf(JiraImportInfo.NO_WORKING_DAY), onlyHoliday.item.infos)
        assertEquals(listOf(JiraImportInfo.NO_WORKING_DAY), milestone(start = "2027-02-06", end = "2027-02-07").item.infos, "a weekend")
        assertTrue(milestone(start = MONDAY, end = "2027-02-02", calendar = holiday).item.scheduled, "one working day left is enough")
        assertTrue(milestone(start = MONDAY, end = MONDAY).item.scheduled, "the same day without the holiday")
    }

    @Test
    fun `copyDates off copies no dates, shows none and says nothing`() {
        val row = milestone(start = MONDAY, end = "2027-02-03", copyDates = false)
        assertEquals(JiraImportAction.CREATE, row.item.action)
        assertFalse(row.item.scheduled)
        assertNull(row.span)
        assertNull(row.item.startDate)
        assertNull(row.item.endDate)
        assertTrue(row.item.infos.isEmpty())
        assertTrue(milestone(copyDates = false).item.infos.isEmpty())
    }

    @Test
    fun `only milestones carry an estimate, dates and a team`() {
        val preview = ImportCase(fullTree(), defaults = JiraImportDefaults(teamId = 10u)).plan()
        for (id in listOf("100", "200", "201")) {
            val item = preview.row(id).item
            assertNull(item.estimateMd, id)
            assertNull(item.team, id)
            assertFalse(item.canSchedule, id)
            assertNull(preview.row(id).estimate)
        }
        assertEquals(10u, preview.row("300").item.team!!.id)
    }

    @Test
    fun `a name cut from a long summary is reported on the row, whatever its action`() {
        val preview = ImportCase(
            listOf(issue("500", JIRA_STORY, "y".repeat(120)), issue("300", JIRA_EPIC, "z".repeat(101), parent = "999")),
        ).plan()
        assertEquals(listOf(JiraImportInfo.NAME_TRUNCATED), preview.row("500").item.infos)
        assertEquals(listOf(JiraImportInfo.NAME_TRUNCATED), preview.row("300").item.infos)
        assertEquals(100, preview.row("300").item.name.length)
    }

    @Test
    fun `a truncated mixed-case name binds an existing node of exactly 100 characters`() {
        val existing = "ab".repeat(50)
        val tree = ImportTree(stream.programs, listOf(node(9u, existing, parentId = 7u)), emptyList())
        val preview = ImportCase(
            listOf(issue("200", JIRA_PROJECT, "AB".repeat(50) + "TAIL TAIL")),
            tree = tree,
            defaults = JiraImportDefaults(programId = 7u),
        ).plan()
        assertEquals(JiraImportAction.BIND, preview.row("200").item.action)
        assertEquals(9u, preview.row("200").item.target!!.nodeId)
        assertEquals(listOf(JiraImportInfo.NAME_TRUNCATED), preview.row("200").item.infos)
    }

    @Test
    fun `only a row an apply writes carries a release`() {
        val boundTree = ImportTree(stream.programs + node(2u, "Bound program", bound = true), stream.projects, stream.milestones)
        val issues = listOf(
            issue("100", JIRA_PROGRAM, "Fresh"), issue("101", JIRA_PROGRAM, "bound program"), issue("200", JIRA_PROJECT, parent = "101"),
            issue("300", JIRA_EPIC, "Nobody's", team = "Nobody"), issue("301", JIRA_EPIC, "Changing", team = "Platform"),
            issue("302", JIRA_EPIC, "Writing", team = "Platform"),
        )
        val dead = listOf("100", "101", "200", "300", "301", "302").mapIndexed { i, id ->
            holder(id, JiraLevel.MILESTONE, 90u + i.toUInt(), "Gone", live = false, bindingId = 30u + i.toUInt())
        }
        val case = ImportCase(issues, tree = boundTree, holders = dead, defaults = JiraImportDefaults(projectId = 7u))
        val preview = case.plan()
        assertEquals(listOf("100", "301", "302"), preview.rows.filter { it.releases.isNotEmpty() }.map { it.item.jiraId })
        for (id in listOf("101", "200", "300")) assertTrue(preview.row(id).releases.isEmpty(), "$id is skipped, so it releases nothing")
        assertEquals(JiraImportReason.NAME_TAKEN, preview.row("101").item.reason)
        assertEquals(JiraImportReason.PARENT_SKIPPED, preview.row("200").item.reason)
        assertEquals(JiraImportReason.NO_TEAM, preview.row("300").item.reason)
        assertTrue(preview.releases.isEmpty(), "a preview writes nothing")

        val ticks = tickable(preview, "100").map { t ->
            if (t.jiraId == "301") JiraImportApplyItem("301", t.expected.copy(level = JiraLevel.PROJECT)) else t
        } + tick(preview.row("200"))
        val applied = case.plan(ticks)
        assertEquals(ImportApply.NotRequested, applied.row("100").apply)
        assertEquals(JiraImportReason.CHANGED, (applied.row("301").apply as ImportApply.Skipped).reason)
        assertEquals(listOf("302"), applied.writes.map { it.item.jiraId })
        assertEquals(listOf(35u), applied.releases.map { it.bindingId })
        for (id in listOf("100", "101", "200", "300", "301")) assertTrue(applied.row(id).releases.isEmpty(), "$id is not written")
        assertEquals(listOf(35u), applied.row("302").releases.map { it.bindingId })
    }

    // ---- The cap ----------------------------------------------------------------------------------------------------------------

    @Test
    fun `more than 2000 issues keep the lowest ids and flag the answer truncated`() {
        val many = (1..MAX_IMPORT_ITEMS + 1).map { issue("${100_000 + it}", JIRA_EPIC, "Epic $it") }.shuffled(java.util.Random(7))
        val preview = ImportCase(many, tree = stream, defaults = JiraImportDefaults(projectId = 7u, teamId = 10u)).plan()
        assertEquals(MAX_IMPORT_ITEMS, preview.rows.size)
        assertTrue(preview.truncated)
        assertTrue(preview.totals().truncated)
        assertEquals(MAX_IMPORT_ITEMS, preview.totals().items)
        assertEquals("100001", preview.rows.first().item.jiraId)
        assertEquals("102000", preview.rows.last().item.jiraId)
    }

    @Test
    fun `exactly 2000 issues are not truncated, and a browse that stopped early is`() {
        val exact = (1..MAX_IMPORT_ITEMS).map { issue("${100_000 + it}", JIRA_EPIC, "Epic $it") }
        val case = ImportCase(exact, tree = stream, defaults = JiraImportDefaults(projectId = 7u, teamId = 10u))
        assertFalse(case.plan().truncated)
        assertEquals(MAX_IMPORT_ITEMS, case.plan().rows.size)
        val stopped = ImportCase(exact.take(3), browseTruncated = true).plan()
        assertTrue(stopped.truncated)
        assertEquals(3, stopped.rows.size)
    }

    @Test
    fun `the as-of instant passes through untouched`() {
        assertEquals(42L, ImportCase(emptyList()).plan().asOf)
    }
}
