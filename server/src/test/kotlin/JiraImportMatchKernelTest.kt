package ch.nokillswit

import ch.nokillswit.jira.ImportApply
import ch.nokillswit.jira.ImportBrowsedIssue
import ch.nokillswit.jira.ImportNameMatch
import ch.nokillswit.jira.ImportPlan
import ch.nokillswit.jira.ImportRootNode
import ch.nokillswit.jira.ImportTree
import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportInfo
import ch.nokillswit.jira.JiraImportParentKind
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraLevel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The suggested matches of the import kernel (1.15) as pure vectors. The plan: program 7 holds projects 10 ("Initiative North", free),
 * 11 ("Initiative East", linked) and 12 ("Initiative South", free); project 10 holds milestone 20 ("Existing milestone"). Jira issue
 * "100" is the program (held by program 7), "200" a project, "300" a milestone under it.
 */
class JiraImportMatchKernelTest {
    private val tree = ImportTree(
        programs = listOf(node(7u, "Platform program")),
        projects = listOf(
            node(10u, "Initiative North", 7u), node(11u, "Initiative East", 7u, bound = true), node(12u, "Initiative South", 7u),
        ),
        milestones = listOf(node(20u, "Existing milestone", 10u), node(21u, "Release checklist", 12u)),
    )
    private val programHeld = holder("100", JiraLevel.PROGRAM, 7u, "Platform program")

    private fun base(projectName: String = "North initiative") = listOf(
        issue("100", JIRA_PROGRAM, "Platform program"),
        issue("200", JIRA_PROJECT, projectName, parent = "100"),
        issue("300", JIRA_EPIC, "Existing milestone", parent = "200", team = "Platform"),
    )

    private fun case(
        issues: List<ImportBrowsedIssue> = base(),
        matches: Map<String, UInt> = emptyMap(),
        tree: ImportTree = this.tree,
        holders: List<ch.nokillswit.jira.ImportHolder> = listOf(programHeld),
        defaults: JiraImportDefaults = JiraImportDefaults(teamId = PLATFORM.id),
        root: ImportRootNode? = null,
    ) = ImportCase(issues, tree = tree, holders = holders, defaults = defaults, matches = matches, root = root)

    @Test
    fun `a CREATE under an existing parent gets the suggestion, and nothing else about the row changes`() {
        val plan = case().plan()
        val project = plan.row("200").item
        assertEquals(JiraImportAction.CREATE, project.action)
        assertEquals(10u, project.suggestion!!.nodeId)
        assertEquals("Initiative North", project.suggestion.nodeName)
        assertEquals(JiraImportParentKind.EXISTING, project.parent!!.kind)
        // Under the NEW row of the project there are no siblings to compare with.
        val milestone = plan.row("300").item
        assertEquals(listOf(JiraImportAction.CREATE, JiraImportParentKind.NEW_ROW), listOf(milestone.action, milestone.parent!!.kind))
        assertNull(milestone.suggestion)
        assertEquals(listOf(0, 2, 1), plan.totals().let { listOf(it.bind, it.create, it.skip) })
    }

    @Test
    fun `an exact-name sibling still BINDs and is suggested to nobody, a linked or claimed sibling is no candidate`() {
        val issues = base() + issue("201", JIRA_PROJECT, "Initiative North", parent = "100") +
            issue("202", JIRA_PROJECT, "East initiative", parent = "100")
        val plan = case(issues).plan()
        val exact = plan.row("201").item
        assertEquals(listOf(JiraImportAction.BIND, 10u), listOf(exact.action, exact.target!!.nodeId))
        assertNull(plan.row("200").item.suggestion, "node 10 is claimed by the exact-name row")
        assertNull(plan.row("202").item.suggestion, "node 11 is linked already")
    }

    @Test
    fun `a program row is compared with the stream's unlinked programs`() {
        val plan = case(listOf(issue("100", JIRA_PROGRAM, "Platform Program Renamed")), holders = emptyList()).plan()
        val program = plan.row("100").item
        assertEquals(JiraImportAction.CREATE, program.action)
        assertEquals(7u, program.suggestion!!.nodeId)
    }

    @Test
    fun `the default parent's children are compared too`() {
        val orphan = listOf(issue("310", JIRA_EPIC, "Milestone existing", team = "Platform"))
        val plan = case(orphan, holders = emptyList(), defaults = JiraImportDefaults(projectId = 10u, teamId = PLATFORM.id)).plan()
        val item = plan.row("310").item
        assertEquals(listOf(JiraImportAction.CREATE, JiraImportParentKind.DEFAULT), listOf(item.action, item.parent!!.kind))
        assertEquals(20u, item.suggestion!!.nodeId)
    }

    @Test
    fun `a milestone without a team is a NO_TEAM skip and gets no suggestion`() {
        val orphan = listOf(issue("310", JIRA_EPIC, "Milestone existing"))
        val plan = case(orphan, holders = emptyList(), defaults = JiraImportDefaults(projectId = 10u), root = null).plan()
        val item = plan.row("310").item
        assertEquals(listOf(JiraImportAction.SKIP, JiraImportReason.NO_TEAM), listOf(item.action, item.reason))
        assertNull(item.suggestion)
    }

    @Test
    fun `a confirmed match is a BIND, and what hangs under it lands under the EXISTING node and matches its children by name`() {
        val plan = case(matches = mapOf("200" to 10u)).plan()
        val project = plan.row("200").item
        assertEquals(JiraImportAction.BIND, project.action)
        assertEquals(listOf(10u, "Initiative North"), listOf(project.target!!.nodeId, project.target.nodeName))
        assertEquals(listOf(JiraImportInfo.MATCH_CONFIRMED), project.infos)
        assertNull(project.suggestion)
        assertNull(project.team)
        assertNull(project.estimateMd)
        val milestone = plan.row("300").item
        assertEquals(JiraImportAction.BIND, milestone.action, "'Existing milestone' is a child of the existing project 10")
        assertEquals(20u, milestone.target!!.nodeId)
        assertEquals(JiraImportParentKind.EXISTING, milestone.parent!!.kind)
        assertEquals(listOf(2, 0, 1), plan.totals().let { listOf(it.bind, it.create, it.skip) })
    }

    @Test
    fun `a confirmed milestone needs no team, so its Jira team name is no longer unmatched`() {
        val orphan = listOf(issue("310", JIRA_EPIC, "Milestone existing", team = "Unknown crew"))
        val defaults = JiraImportDefaults(projectId = 10u, teamId = PLATFORM.id)
        assertEquals(listOf("Unknown crew"), case(orphan, holders = emptyList(), defaults = defaults).plan().unmatchedTeams)
        val confirmed = case(orphan, matches = mapOf("310" to 20u), holders = emptyList(), defaults = defaults).plan()
        assertEquals(JiraImportAction.BIND, confirmed.row("310").item.action)
        assertTrue(confirmed.unmatchedTeams.isEmpty())
    }

    @Test
    fun `an entry that is not the kernel's own suggestion changes no row`() {
        val issues = base() + issue("201", JIRA_PROJECT, "Initiative East renamed", parent = "100")
        val plain = case(issues).plan()
        val entries = mapOf(
            "200" to 12u, // another unlinked node
            "201" to 11u, // a linked node
            "9999" to 10u, // an id the browse does not hold
            "100" to 7u, // a row that is not a CREATE
        )
        entries.forEach { (jiraId, nodeId) ->
            val stray = case(issues, matches = mapOf(jiraId to nodeId)).plan()
            assertEquals(describe(plain), describe(stray), "the entry $jiraId -> $nodeId")
        }
        assertEquals(describe(plain), describe(case(issues, matches = entries).plan()))
    }

    @Test
    fun `an ambiguous scope proposes nothing - two nodes for one row`() {
        val ambiguous = tree.let { ImportTree(it.programs, it.projects + node(13u, "Initiative north revised", 7u), it.milestones) }
        assertNull(case(tree = ambiguous).plan().row("200").item.suggestion)
    }

    @Test
    fun `the answer does not depend on the order of the issues or of the plan's nodes`() {
        val issues = base() + issue("201", JIRA_PROJECT, "South initiative", parent = "100")
        val shuffledTree = ImportTree(tree.programs, tree.projects.reversed(), tree.milestones.reversed())
        val a = case(issues).plan()
        val b = case(issues.reversed(), tree = shuffledTree).plan()
        assertEquals(describe(a), describe(b))
        assertEquals(10u, a.row("200").item.suggestion!!.nodeId)
        assertEquals(12u, a.row("201").item.suggestion!!.nodeId)
    }

    @Test
    fun `with a root, OUTSIDE_ROOT still wins and no suggestion is made for a skipped row`() {
        val other = ImportTree(
            tree.programs + node(8u, "Other program"),
            tree.projects + node(30u, "Other project", 8u),
            tree.milestones + node(31u, "Rollout portal", 30u),
        )
        val issues = listOf(
            issue("100", JIRA_PROGRAM, "Platform program"),
            issue("201", JIRA_PROJECT, "Other project", parent = "100"),
            issue("301", JIRA_EPIC, "Portal rollout", parent = "201", team = "Platform"),
        )
        val holders = listOf(programHeld, holder("201", JiraLevel.PROJECT, 30u, "Other project"))
        val plan = case(issues, tree = other, holders = holders, root = ImportRootNode(JiraLevel.PROGRAM, 7u)).plan()
        val item = plan.row("301").item
        assertEquals(listOf(JiraImportAction.SKIP, JiraImportReason.OUTSIDE_ROOT), listOf(item.action, item.reason))
        assertNull(item.suggestion)
        // The same row in a whole-scope import is a CREATE that looks like the other project's milestone.
        assertEquals(31u, case(issues, tree = other, holders = holders).plan().row("301").item.suggestion!!.nodeId)
    }

    // ---- the apply ----------------------------------------------------------------------------------------------------------------

    @Test
    fun `an apply writes a confirmed match as the BIND the preview showed`() {
        val matches = mapOf("200" to 10u)
        val preview = case(matches = matches).plan()
        val applied = case(matches = matches).plan(tickable(preview))
        assertEquals(listOf("200", "300"), applied.writes.map { it.item.jiraId })
        assertEquals(listOf(JiraImportAction.BIND, JiraImportAction.BIND), applied.writes.map { it.item.action })
    }

    @Test
    fun `a confirmation that is stale or missing under the lock is CHANGED, nothing written`() {
        val matches = mapOf("200" to 10u)
        val ticks = tickable(case(matches = matches).plan())
        // The node was renamed meanwhile: no suggestion, so the row is a CREATE where a BIND was expected.
        val renamed = withProject10(node(10u, "Initiative Northwest", 7u))
        val stale = case(tree = renamed, matches = matches).plan(ticks)
        assertEquals(JiraImportReason.CHANGED, assertIs<ImportApply.Skipped>(stale.row("200").apply).reason)
        // Linked meanwhile.
        val linked = withProject10(node(10u, "Initiative North", 7u, bound = true))
        val relinked = case(tree = linked, matches = matches).plan(ticks)
        assertEquals(JiraImportReason.CHANGED, assertIs<ImportApply.Skipped>(relinked.row("200").apply).reason)
        // The entry left out of the apply request.
        val missing = case().plan(ticks)
        assertEquals(JiraImportReason.CHANGED, assertIs<ImportApply.Skipped>(missing.row("200").apply).reason)
        assertTrue(missing.writes.none { it.item.jiraId == "200" })
    }

    @Test
    fun `two confirmations in one scope both bind, each to its own node`() {
        val issues = base() + issue("201", JIRA_PROJECT, "South initiative", parent = "100")
        val plan = case(issues, matches = mapOf("200" to 10u, "201" to 12u)).plan()
        assertEquals(
            listOf(JiraImportAction.BIND to 10u, JiraImportAction.BIND to 12u),
            listOf("200", "201").map { plan.row(it).item.let { item -> item.action to item.target!!.nodeId } },
        )
        assertEquals(listOf(JiraImportInfo.MATCH_CONFIRMED), plan.row("201").item.infos)
    }

    @Test
    fun `a confirmed PROGRAM bind lands its projects under the existing program and matches its projects by name`() {
        val issues = listOf(
            issue("100", JIRA_PROGRAM, "Platform Program Renamed"),
            issue("200", JIRA_PROJECT, "Initiative North", parent = "100"),
            issue("201", JIRA_PROJECT, "Brand new project", parent = "100"),
        )
        val plain = case(issues, holders = emptyList()).plan()
        assertEquals(JiraImportAction.CREATE, plain.row("200").item.action, "under a new program nothing matches by name")
        assertEquals(JiraImportParentKind.NEW_ROW, plain.row("200").item.parent!!.kind)
        val plan = case(issues, matches = mapOf("100" to 7u), holders = emptyList()).plan()
        val program = plan.row("100").item
        assertEquals(
            listOf(JiraImportAction.BIND, 7u, listOf(JiraImportInfo.MATCH_CONFIRMED)),
            listOf(program.action, program.target!!.nodeId, program.infos),
        )
        val bound = plan.row("200").item
        assertEquals(listOf(JiraImportAction.BIND, 10u), listOf(bound.action, bound.target!!.nodeId), "Initiative North is project 10")
        val created = plan.row("201").item
        assertEquals(JiraImportAction.CREATE, created.action)
        assertEquals(listOf(JiraImportParentKind.EXISTING, 7u), created.parent!!.let { listOf(it.kind, it.nodeId) })
    }

    // ---- an apply's team override never changes who competes -----------------------------------------------------------------

    private val orphans = JiraImportDefaults(projectId = 10u)
    private val teamless = issue("311", JIRA_EPIC, "Existing milestone extra")
    private val teamed = issue("310", JIRA_EPIC, "Milestone existing", team = "Platform")

    private fun overrideTick(id: String, team: UInt) = ch.nokillswit.jira.JiraImportApplyItem(
        id,
        ch.nokillswit.jira.JiraImportExpected(
            JiraImportAction.CREATE, JiraLevel.MILESTONE, null, null,
            ch.nokillswit.jira.JiraImportExpectedParent(JiraImportParentKind.DEFAULT, 10u), null,
        ),
        ch.nokillswit.jira.JiraImportOverrides(team),
    )

    @Test
    fun `a NO_TEAM row that an override turns into a CREATE does not compete, so an honest confirmation still holds`() {
        val matches = mapOf("310" to 20u)
        val preview = case(listOf(teamed, teamless), matches = matches, holders = emptyList(), defaults = orphans).plan()
        assertEquals(JiraImportReason.NO_TEAM, preview.row("311").item.reason)
        assertEquals(JiraImportAction.BIND, preview.row("310").item.action)
        val ticks = tickable(preview) + overrideTick("311", PLATFORM.id)
        val applied = case(listOf(teamed, teamless), matches = matches, holders = emptyList(), defaults = orphans).plan(ticks)
        assertEquals(JiraImportAction.CREATE, applied.row("311").item.action, "the override made it a CREATE")
        assertNull(applied.row("311").item.suggestion)
        assertIs<ImportApply.Write>(applied.row("310").apply, "the confirmation is not turned into CHANGED")
    }

    @Test
    fun `an override cannot honour a pair no preview showed - a NO_TEAM row given a team is not confirmed`() {
        val matches = mapOf("311" to 20u)
        val issues = listOf(teamless)
        val preview = case(issues, matches = matches, holders = emptyList(), defaults = orphans).plan()
        assertEquals(JiraImportReason.NO_TEAM, preview.row("311").item.reason)
        val ticks = listOf(overrideTick("311", PLATFORM.id))
        val applied = case(issues, matches = matches, holders = emptyList(), defaults = orphans).plan(ticks)
        val row = applied.row("311").item
        assertEquals(listOf(JiraImportAction.CREATE, null), listOf(row.action, row.suggestion?.nodeId), "no suggestion, no BIND")
    }

    // ---- scale --------------------------------------------------------------------------------------------------------------------

    @Test
    fun `2,000 rows against 1,000 unlinked siblings under one parent settle well inside the tripwire`() {
        fun word(k: Int) = "" + ('a' + k / 676 % 26) + ('a' + k / 26 % 26) + ('a' + k % 26)
        val nodes = (0 until 1_000).map { node(1_000u + it.toUInt(), "alpha ${word(it)}", 10u) }
        val scaleTree = ImportTree(tree.programs, tree.projects, nodes)
        val issues = (0 until 1_999).map { issue("${1_000 + it}", JIRA_EPIC, "alpha ${word(it)} rollout", team = "Platform") }
        val case = ImportCase(issues, tree = scaleTree, defaults = JiraImportDefaults(projectId = 10u, teamId = PLATFORM.id))
        lateinit var plan: ImportPlan
        val ms = ScaleFigures.timedMs { plan = case.plan() }
        ScaleFigures.print("jira-import suggested matches, 1,999 rows against 1,000 unlinked siblings", ms)
        assertEquals(1_000, plan.rows.count { it.item.suggestion != null })
        assertTrue(ms <= TRIPWIRE_MS, "the kernel took $ms ms")
    }

    @Test
    fun `the work budget - the worst case inside it stays inside the tripwire, and past it a scope gets nothing`() {
        val vocabulary = listOf("alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet")
        // Every name is five of ten shared words: each word has a posting list of about half the siblings.
        fun name(k: Int, extra: String) = (0 until 5).joinToString(" ") { vocabulary[(k * 7 + it * 3 + it * it * k) % 10] } + " " + extra
        fun nodes(count: Int) = (0 until count).map { (1_000u + it.toUInt()) to name(it, "node$it".replace(Regex("\\d"), "q")) }
        fun rows(count: Int) = (0 until count).map { "$it" to name(it + 1, "row$it".replace(Regex("\\d"), "z")) }
        // One pair that shares no vocabulary word: it is proposed only if the scope was not refused.
        val insideRows = rows(1_100) + ("pair" to "uniqueone uniquetwo")
        val insideNodes = nodes(2_600) + (5_000u to "uniqueone uniquetwo uniquethree")
        val within = ImportNameMatch.pairs(insideRows, insideNodes)
        val inside = ScaleFigures.timedMs { ImportNameMatch.pairs(insideRows, insideNodes) }
        ScaleFigures.print("jira-import suggested matches, worst case inside the budget (1,100 rows, 2,600 siblings, 4.8M of 5M)", inside)
        assertEquals(5_000u, within["pair"], "the scope was inside the budget")
        assertTrue(inside <= TRIPWIRE_MS * 2, "inside the budget took $inside ms")
        // 2,000 rows against 3,000 siblings is over the budget: nothing is proposed, and the answer comes at once.
        var over: Map<String, UInt> = mapOf("x" to 0u)
        val refused = ScaleFigures.timedMs { over = ImportNameMatch.pairs(rows(2_000), nodes(3_000)) }
        ScaleFigures.print("jira-import suggested matches, over the budget (2,000 rows, 3,000 siblings)", refused)
        assertTrue(over.isEmpty(), "past the budget a scope gets no suggestion at all")
        assertTrue(refused <= TRIPWIRE_MS, "the refusal took $refused ms")
    }

    private fun withProject10(replacement: ch.nokillswit.jira.ImportPlanNode) =
        ImportTree(tree.programs, tree.projects.map { if (it.id == 10u) replacement else it }, tree.milestones)

    private fun describe(plan: ImportPlan) = plan.rows.map { row ->
        with(row.item) {
            listOf(jiraId, action, reason, target?.nodeId, parent?.kind, parent?.nodeId, suggestion?.nodeId, infos).joinToString("|")
        }
    }

    private companion object {
        /** Loose: well over 5x the figure measured on the dev machine. */
        const val TRIPWIRE_MS = 1_000.0
    }
}
