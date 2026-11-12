package ch.nokillswit

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.jira.CHILD_PARENT_CHUNK
import ch.nokillswit.jira.ChildBrowse
import ch.nokillswit.jira.ImportBrowse
import ch.nokillswit.jira.ImportRoot
import ch.nokillswit.jira.ImportTree
import ch.nokillswit.jira.JIRA_ROOT_UNUSABLE_PROBLEM
import ch.nokillswit.jira.JiraAuthScheme
import ch.nokillswit.jira.JiraBindContext
import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportFilter
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraLevelMapping
import ch.nokillswit.jira.JiraMapping
import ch.nokillswit.jira.JiraMappingState
import ch.nokillswit.jira.JiraTestTarget
import ch.nokillswit.jira.StoredMapping
import ch.nokillswit.jira.browseChildren
import ch.nokillswit.jira.observationFields
import ch.nokillswit.jira.requireRootRow
import ch.nokillswit.jira.withoutRow
import io.ktor.http.HttpHeaders
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * `browseChildren` over a scripted site (the rooted import's read, 1.14): the root by id, the rounds and their `jql` / `fields`, the
 * server's own verdict on every entry, the filter, the bounds, and the plan side's two pure helpers. Issue ids are the stub's (`IMC-n` is
 * id `99000 + n`: `IMC-1` the program, `IMC-2..4` its projects, the rest milestones). No database, no application.
 */
class JiraImportChildrenTest {
    private val token = "UNIT-TOKEN-do-not-leak"
    private val keys = listOf("IMC")
    private val target = JiraTestTarget("https://unit.atlassian.net", "a@example.test", token, JiraAuthScheme.BASIC, keys)
    private val context = JiraBindContext(target, JiraMappingState(StoredMapping.Unset, IMPORT_DISCOVERY), true)
    private val today = java.time.Instant.parse("2026-11-11T00:00:00Z").toEpochMilli()
    private val recent = "2026-11-01T10:00:00.000+0000"
    private val quiet = "2025-01-01T10:00:00.000+0000"
    private val programRoot = ImportRoot(JiraLevel.PROGRAM, 5u, 900u, id(1))
    private val projectRoot = ImportRoot(JiraLevel.PROJECT, 6u, 901u, id(2))
    private val done = JiraImportFilter(excludeDone = true, updatedWithinDays = 365)

    private fun id(n: Int) = "${99_000 + n}"

    /** `IMC-[n]` at Jira level [level] (1 epic, 2 initiative, 3 program) under `IMC-[parent]`, with a status and a stamp. */
    private fun doc(
        n: Int,
        level: Int,
        parent: Int? = null,
        isDone: Boolean = false,
        updated: String = recent,
        key: String = "IMC-$n",
        docId: String = id(n),
        parentId: String? = parent?.let { id(it) },
    ): String {
        fun type(at: Int) = """{"id":"${10003 + at}","name":"L$at","subtask":false,"hierarchyLevel":$at}"""
        val category = if (isDone) "done" else "indeterminate"
        val parentMember = parentId?.let { ""","parent":{"id":"$it","key":"IMC-x","fields":{"issuetype":${type(level + 1)}}}""" }.orEmpty()
        return """{"id":"$docId","key":"$key","fields":{"summary":"Issue $key","issuetype":${type(level)},""" +
            """"status":{"name":"S","statusCategory":{"key":"$category"}},"updated":"$updated"$parentMember}}"""
    }

    private fun answer(body: String, status: Int = 200) = ScriptedIssue(status, body)

    private fun rootIssues(vararg pairs: Pair<Int, String>) = pairs.associate { (n, body) -> id(n) to answer(body) }

    private fun browse(
        site: ScriptedSite,
        root: ImportRoot = programRoot,
        filter: JiraImportFilter? = null,
        mapping: JiraMapping = importMapping(),
        cap: Int = 2_000,
        beforePage: suspend () -> Unit = {},
        deadlineMillis: Long = 60_000,
        connectionKeys: List<String> = keys,
    ): ImportBrowse = runBlocking {
        browseChildren(
            site.connector, context, token, ChildBrowse(keys, connectionKeys, root, filter), mapping, IMPORT_DISCOVERY, today, beforePage,
            cap, deadlineMillis,
        )
    }

    private fun ids(result: ImportBrowse) = result.issues.map { it.observation.issueId }

    private fun jql(site: ScriptedSite, index: Int) = site.searches[index].url.parameters["jql"]

    /** The stub's whole tree (docs of `IMC-1..10` as `sample-data/jira/world.mjs` lists them): what a program import walks. */
    private fun programSite(onSearch: suspend (Int) -> Unit = {}): ScriptedSite = ScriptedSite(
        searchPage(doc(2, 2, 1), doc(3, 2, 1, isDone = true), doc(4, 2, 1, isDone = true), doc(9, 1, 1)),
        searchPage(
            doc(5, 1, 2), doc(6, 1, 2, isDone = true), doc(7, 1, 3), doc(8, 1, 4, isDone = true), doc(10, 1, 2, updated = quiet),
        ),
        issues = rootIssues(1 to doc(1, 3)),
        onSearch = onSearch,
    )

    // ---- the rounds -------------------------------------------------------------------------------------------------------------

    @Test
    fun `a program root reads the root by id, then its children over both types, then the milestones under the projects`() {
        val site = programSite()
        val result = browse(site)
        assertEquals(listOf(id(1)), site.issueReads, "the root by id, once")
        assertEquals(2, site.searches.size)
        assertEquals("""project in ("IMC") AND issuetype in (10005,10004) AND parent in (99001) ORDER BY id ASC""", jql(site, 0))
        assertEquals(
            """project in ("IMC") AND issuetype in (10004) AND parent in (99002,99003,99004) ORDER BY id ASC""", jql(site, 1),
            "round two: the milestone level only, every project of round one, ascending",
        )
        val fields = observationFields(importMapping())
        assertEquals(fields, site.issueRequests.single().url.parameters["fields"])
        assertTrue(site.searches.all { it.url.parameters["fields"] == fields })
        assertEquals(listOf(1, 2, 3, 4, 9, 5, 6, 7, 8, 10).map { id(it) }, ids(result), "the root first, then round one, then round two")
        assertFalse(result.truncated)
        assertTrue(result.issues.none { it.keptAsParent || it.parentUnreadable })
    }

    @Test
    fun `a project root is one round over the milestone type, and a mapping without the project level is too`() {
        val site = ScriptedSite(
            searchPage(doc(5, 1, 2), doc(6, 1, 2), doc(10, 1, 2)),
            issues = rootIssues(2 to doc(2, 2, parent = 1)),
        )
        val result = browse(site, projectRoot)
        assertEquals(listOf(id(2)), site.issueReads)
        assertEquals(1, site.searches.size)
        assertEquals("""project in ("IMC") AND issuetype in (10004) AND parent in (99002) ORDER BY id ASC""", jql(site, 0))
        assertEquals(listOf(2, 5, 6, 10).map { id(it) }, ids(result))

        val noProjects = ScriptedSite(searchPage(doc(9, 1, 1)), issues = rootIssues(1 to doc(1, 3)))
        val flat = browse(noProjects, mapping = importMapping(project = false))
        assertEquals(1, noProjects.searches.size, "no project level, no second round")
        assertEquals("""project in ("IMC") AND issuetype in (10004) AND parent in (99001) ORDER BY id ASC""", jql(noProjects, 0))
        assertEquals(listOf(1, 9).map { id(it) }, ids(flat))
    }

    @Test
    fun `a root with nothing under it answers the root alone, after one search`() {
        val site = ScriptedSite(searchPage(), issues = rootIssues(14 to doc(14, 3)))
        val result = browse(site, ImportRoot(JiraLevel.PROGRAM, 5u, 900u, id(14)))
        assertEquals(listOf(id(14)), ids(result))
        assertEquals(1, site.searches.size, "no project held, so no second round")
        assertFalse(result.truncated)
    }

    @Test
    fun `120 projects are three round-two queries of 50, 50 and 20 parents, in numeric id order`() {
        // Ids 900..1019 (99900..100019): the shorter ids sort before the longer ones as numbers, as text order would not.
        val projects = (900..1019).map { doc(it, 2, 1) }
        val site = ScriptedSite(
            searchPage(*projects.toTypedArray()), searchPage(), searchPage(), searchPage(),
            issues = rootIssues(1 to doc(1, 3)),
        )
        browse(site)
        assertEquals(4, site.searches.size)
        val parents = (1..3).map { jql(site, it).orEmpty().substringAfter("parent in (").substringBefore(")").split(",") }
        assertEquals(listOf(CHILD_PARENT_CHUNK, CHILD_PARENT_CHUNK, 20), parents.map { it.size })
        assertEquals((900..949).map { id(it) }, parents[0])
        assertEquals((950..999).map { id(it) }, parents[1])
        assertEquals((1000..1019).map { id(it) }, parents[2])
        assertTrue(site.searches.drop(1).all { "issuetype in (10004) AND parent in (" in it.url.parameters["jql"].orEmpty() })
    }

    // ---- the server's own verdict on every entry --------------------------------------------------------------------------------

    @Test
    fun `an entry is dropped unless it names a parent THIS query asked for, sits below it, is in the keys and is not a repeat`() {
        val site = ScriptedSite(
            searchPage(
                doc(2, 2, 1),
                doc(2, 2, 1), // a repeat (a restart re-delivers pages): counts once
                doc(20, 1, 777), // a parent nobody asked for
                doc(21, 1, parentId = null), // no parent at all
                doc(22, 1, 1, key = "OTHER-22"), // a project outside the import's keys
                doc(23, 0, 1), // a level the mapping does not map
                doc(24, 3, 1), // the program level: not below its parent
                doc(1, 3, 1), // the root itself, as its own child
            ),
            searchPage(doc(5, 1, 2), doc(30, 1, 3), doc(31, 2, 2), doc(32, 3, 2), doc(33, 1, 4)),
            issues = rootIssues(1 to doc(1, 3)),
        )
        val result = browse(site)
        assertEquals(listOf(1, 2, 5).map { id(it) }, ids(result))
        assertEquals(2, site.searches.size, "round two named only the one project that was held")
        assertEquals(id(2), jql(site, 1).orEmpty().substringAfter("parent in (").substringBefore(")"))
    }

    @Test
    fun `a milestone round never holds an initiative, and a second chunk's entry must name one of ITS parents`() {
        val projects = (900..950).map { doc(it, 2, 1) }
        val site = ScriptedSite(
            searchPage(*projects.toTypedArray()),
            searchPage(doc(5000, 1, 900), doc(5001, 1, 950)), // chunk one names 900..949: 950 is chunk two's
            searchPage(doc(5002, 1, 950), doc(5003, 1, 900)), // chunk two names 950 only
            issues = rootIssues(1 to doc(1, 3)),
        )
        val result = browse(site)
        val held = ids(result).filter { it.toInt() > 99_000 + 4_000 }
        assertEquals(listOf(5000, 5002).map { id(it) }, held)
    }

    // ---- the filter -------------------------------------------------------------------------------------------------------------

    @Test
    fun `under a filter round one carries no clause and round two does, and the server's rule judges what the site returned`() {
        val site = programSite()
        val result = browse(site, filter = done)
        assertEquals("""project in ("IMC") AND issuetype in (10005,10004) AND parent in (99001) ORDER BY id ASC""", jql(site, 0))
        assertEquals(
            """project in ("IMC") AND issuetype in (10004) AND parent in (99002,99003,99004) AND statusCategory != Done """ +
                """AND updated >= "-525600m" ORDER BY id ASC""",
            jql(site, 1),
        )
        // The program row, the open project, the done project with open work (kept as a parent) and what is open and recent; the done
        // project with only done work (IMC-4), the done epics and the quiet one are gone. IMC-9 hangs straight under the program.
        assertEquals(listOf(1, 2, 3, 9, 5, 7).map { id(it) }, ids(result))
        val kept = result.issues.filter { it.keptAsParent }.map { it.observation.issueId }
        assertEquals(listOf(id(3)), kept)
    }

    @Test
    fun `done only and window only judge the same way, and an inactive filter is the plain read`() {
        val doneOnly = browse(programSite(), filter = JiraImportFilter(excludeDone = true))
        assertEquals(listOf(1, 2, 3, 9, 5, 7, 10).map { id(it) }, ids(doneOnly))
        val windowSite = programSite()
        val windowOnly = browse(windowSite, filter = JiraImportFilter(updatedWithinDays = 365))
        // Window only: nothing is done-filtered, so every project stays and every child but the quiet IMC-10 is held.
        assertEquals(listOf(1, 2, 3, 4, 9, 5, 6, 7, 8).map { id(it) }, ids(windowOnly))
        assertTrue(windowOnly.issues.none { it.keptAsParent })
        assertTrue(jql(windowSite, 1).orEmpty().endsWith("""AND updated >= "-525600m" ORDER BY id ASC"""))
        for (inactive in listOf(null, JiraImportFilter())) {
            val site = programSite()
            val plain = browse(site, filter = inactive)
            assertEquals(10, plain.issues.size, "$inactive: everything the site listed")
            assertTrue(site.searches.indices.all { "statusCategory" !in jql(site, it).orEmpty() && "updated" !in jql(site, it).orEmpty() })
        }
    }

    @Test
    fun `a project root narrows its one round, and a leaf the filter does not admit never counts toward the cap`() {
        val site = ScriptedSite(
            searchPage(doc(5, 1, 2), doc(6, 1, 2, isDone = true), doc(10, 1, 2, updated = quiet)),
            issues = rootIssues(2 to doc(2, 2, parent = 1)),
        )
        val result = browse(site, projectRoot, done, cap = 2)
        assertEquals(
            """project in ("IMC") AND issuetype in (10004) AND parent in (99002) AND statusCategory != Done """ +
                """AND updated >= "-525600m" ORDER BY id ASC""",
            jql(site, 0),
        )
        assertEquals(listOf(2, 5).map { id(it) }, ids(result))
        assertFalse(result.truncated, "the two dropped leaves never counted")
    }

    @Test
    fun `a not-admitted project is kept only when a held row hangs under it, and the root is never judged`() {
        val site = ScriptedSite(
            searchPage(doc(3, 2, 1, isDone = true), doc(4, 2, 1, isDone = true)),
            searchPage(doc(8, 1, 4, isDone = true)),
            issues = rootIssues(1 to doc(1, 3, isDone = true, updated = quiet)),
        )
        val result = browse(site, filter = done)
        assertEquals(listOf(id(1)), ids(result), "both done projects are gone: no kept child hangs under either")
        assertFalse(result.issues.single().keptAsParent)
    }

    // ---- the bounds -------------------------------------------------------------------------------------------------------------

    @Test
    fun `every held row counts toward the cap, the root included, and the first row beyond it ends the read`() {
        val site = programSite()
        val result = browse(site, cap = 3)
        assertTrue(result.truncated)
        assertEquals(listOf(1, 2, 3).map { id(it) }, ids(result))
        assertEquals(1, site.searches.size, "truncated in round one: round two is never asked")
        val exact = browse(ScriptedSite(searchPage(doc(2, 2, 1)), searchPage(), issues = rootIssues(1 to doc(1, 3))), cap = 2)
        assertFalse(exact.truncated, "exactly the cap is not truncated")
        val second = browse(
            ScriptedSite(searchPage(doc(2, 2, 1)), searchPage(doc(5, 1, 2), doc(6, 1, 2)), issues = rootIssues(1 to doc(1, 3))), cap = 3,
        )
        assertTrue(second.truncated, "a cap passed in round two truncates too")
        assertEquals(listOf(1, 2, 5).map { id(it) }, ids(second))
    }

    @Test
    fun `a slow search is the browse's TIMEOUT, and so is a slow root read`() {
        val failure = assertFailsWith<FetchException> { browse(programSite(onSearch = { delay(5_000) }), deadlineMillis = 300) }
        assertEquals("TIMEOUT", failure.code)
        val slowRoot = ScriptedSite(
            searchPage(), issues = rootIssues(1 to doc(1, 3)), onIssue = { delay(5_000) },
        )
        assertEquals("TIMEOUT", assertFailsWith<FetchException> { browse(slowRoot, deadlineMillis = 300) }.code)
    }

    @Test
    fun `the connection's stop runs before the root read and before every page`() {
        for (stopAt in 1..3) {
            val site = programSite()
            val asked = AtomicInteger()
            val stopped = assertFailsWith<IllegalStateException>("$stopAt") {
                browse(site, beforePage = { if (asked.incrementAndGet() == stopAt) error("the connection went away") })
            }
            assertEquals("the connection went away", stopped.message)
            assertEquals(if (stopAt == 1) 0 else 1, site.issueReads.size, "$stopAt: the root is read once it is allowed")
            assertEquals(maxOf(0, stopAt - 2), site.searches.size, "$stopAt: a page is sent only after its own stop check")
        }
    }

    // ---- the root ---------------------------------------------------------------------------------------------------------------

    private fun unusable(site: ScriptedSite, root: ImportRoot = programRoot, connectionKeys: List<String> = keys): ConflictException {
        val failure = assertFailsWith<ConflictException> { browse(site, root, connectionKeys = connectionKeys) }
        assertEquals(JIRA_ROOT_UNUSABLE_PROBLEM, failure.problemType)
        val text = failure.message.orEmpty()
        assertTrue(listOf("IMC", "unit.atlassian", token, "99001", "search/jql").none { it in text }, "no key, site, token or id in: $text")
        assertTrue(root.level.name.lowercase() in text, text)
        assertTrue(site.searches.isEmpty(), "no search is sent for a root that cannot be used")
        return failure
    }

    @Test
    fun `a root that answers 404 is the jira-root-unusable 409 naming the plan level only`() {
        unusable(ScriptedSite(searchPage()))
        val failure = unusable(ScriptedSite(searchPage()), ImportRoot(JiraLevel.PROJECT, 6u, 901u, id(2)))
        assertTrue("project" in failure.message.orEmpty())
    }

    @Test
    fun `a root read that fails any other way is the transport's failure, never a verdict`() {
        for ((status, code) in listOf(403 to "FORBIDDEN_SCOPE", 401 to "AUTHENTICATION_FAILED", 429 to "RATE_LIMITED", 500 to null)) {
            val site = ScriptedSite(searchPage(), issues = mapOf(id(1) to answer("""{"errorMessages":["no"]}""", status)))
            val failure = assertFailsWith<FetchException>("$status") { browse(site) }
            if (code != null) assertEquals(code, failure.code, "$status")
            assertTrue(failure.code != "NOT_FOUND", "$status")
            assertTrue(site.searches.isEmpty(), "$status")
        }
    }

    @Test
    fun `a root document of another id, outside the keys, at another level or unreadable is the 409`() {
        unusable(ScriptedSite(searchPage(), issues = rootIssues(1 to doc(1, 3, docId = id(999)))))
        unusable(ScriptedSite(searchPage(), issues = rootIssues(1 to doc(1, 3, key = "OTHER-1"))))
        unusable(ScriptedSite(searchPage(), issues = rootIssues(1 to doc(1, 3))), connectionKeys = listOf("OTHER"))
        unusable(ScriptedSite(searchPage(), issues = rootIssues(1 to doc(1, 2))))
        unusable(ScriptedSite(searchPage(), issues = rootIssues(1 to """{"id":"${id(1)}"}""")))
        // The root's level is the one the MAPPING gives the type: a project-level root document under a program root is the 409 too.
        unusable(ScriptedSite(searchPage(), issues = rootIssues(2 to doc(2, 2))), ImportRoot(JiraLevel.PROGRAM, 5u, 900u, id(2)))
    }

    @Test
    fun `a milestone cannot be a root`() {
        assertFailsWith<IllegalArgumentException> { ImportRoot(JiraLevel.MILESTONE, 1u, 1u, id(5)) }
    }

    @Test
    fun `a mapped level with no issue type is a 409 jira-mapping-invalid before any request`() {
        val site = ScriptedSite(searchPage(), issues = rootIssues(1 to doc(1, 3)))
        val mapping = importMapping().let { it.copy(levels = it.levels.copy(program = JiraLevelMapping(7))) }
        val failure = assertFailsWith<ConflictException> { browse(site, mapping = mapping) }
        assertEquals(ch.nokillswit.jira.JIRA_MAPPING_INVALID_PROBLEM, failure.problemType)
        assertTrue(site.engine.requestHistory.isEmpty())
    }

    @Test
    fun `a page that is no listing is INVALID_RESPONSE and the token rides only the Authorization header`() {
        val bad = ScriptedSite("""{"isLast":true}""", issues = rootIssues(1 to doc(1, 3)))
        assertEquals("INVALID_RESPONSE", assertFailsWith<FetchException> { browse(bad) }.code)
        val site = programSite()
        browse(site)
        for (request in site.engine.requestHistory) {
            assertTrue(token !in request.url.toString(), "the token never rides a URL")
        }
        for (request in site.searches + site.issueRequests) {
            assertTrue(request.headers[HttpHeaders.Authorization].orEmpty().startsWith("Basic "))
        }
    }

    @Test
    fun `a hostile root id is never sent as a by-id request`() {
        for (hostile in listOf("../admin", "1/../2", "12x", "%2e%2e", "1?fields=all", "", " 7", "9".repeat(40))) {
            val site = ScriptedSite(searchPage())
            val failure = assertFailsWith<FetchException>(hostile) { browse(site, ImportRoot(JiraLevel.PROGRAM, 5u, 900u, hostile)) }
            assertEquals("INVALID_RESPONSE", failure.code)
            assertTrue(site.issueRequests.isEmpty() && site.searches.isEmpty(), hostile)
        }
    }

    // ---- the plan side's two pure helpers ---------------------------------------------------------------------------------------

    private fun planOf(holders: List<ch.nokillswit.jira.ImportHolder>, withRoot: Boolean = true) = ImportCase(
        issues = listOfNotNull(
            issue("1", JIRA_PROGRAM).takeIf { withRoot },
            issue("2", JIRA_PROJECT, parent = "1", parentLevel = JIRA_PROGRAM),
        ),
        tree = ImportTree(listOf(node(5u, "Root program", bound = true)), emptyList(), emptyList()),
        holders = holders,
    ).plan()

    @Test
    fun `requireRootRow passes for the root's own ALREADY_BOUND row and its children land under the root node`() {
        val plan = planOf(listOf(holder("1", JiraLevel.PROGRAM, 5u, "Root program")))
        val root = ImportRoot(JiraLevel.PROGRAM, 5u, 905u, "1")
        plan.requireRootRow(root)
        assertEquals(JiraImportReason.ALREADY_BOUND, plan.row("1").reason())
        assertEquals(5u, plan.row("2").item.parent?.nodeId, "the child lands under the root's node")
    }

    @Test
    fun `requireRootRow is the 409 for another node, another kind, an unbound root and an absent row`() {
        val bound = planOf(listOf(holder("1", JiraLevel.PROGRAM, 5u, "Root program")))
        val refused = listOf(
            bound to ImportRoot(JiraLevel.PROGRAM, 6u, 1u, "1"), // the issue is bound to another node
            bound to ImportRoot(JiraLevel.PROJECT, 5u, 1u, "1"), // program 5 is not project 5
            planOf(emptyList()) to ImportRoot(JiraLevel.PROGRAM, 5u, 1u, "1"), // the link is gone: a CREATE row
            planOf(listOf(holder("1", JiraLevel.PROGRAM, 5u, "Root program", live = false))) to ImportRoot(JiraLevel.PROGRAM, 5u, 1u, "1"),
            planOf(emptyList(), withRoot = false) to ImportRoot(JiraLevel.PROGRAM, 5u, 1u, "1"), // not in the browse at all
            bound to ImportRoot(JiraLevel.PROGRAM, 5u, 1u, "2"), // the named issue is another row
        )
        for ((plan, root) in refused) {
            val failure = assertFailsWith<ConflictException> { plan.requireRootRow(root) }
            assertEquals(JIRA_ROOT_UNUSABLE_PROBLEM, failure.problemType)
            assertTrue("program" in failure.message.orEmpty() || "project" in failure.message.orEmpty())
        }
    }

    @Test
    fun `withoutRow drops that row, totals follow, and the rest of the plan is the same`() {
        val plan = planOf(listOf(holder("1", JiraLevel.PROGRAM, 5u, "Root program")))
        assertEquals(2, plan.totals().items)
        assertEquals(1, plan.totals().skip)
        val rest = plan.withoutRow("1")
        assertEquals(listOf("2"), rest.ids())
        val totals = rest.totals()
        assertEquals(listOf(1, 1, 0, 0), listOf(totals.items, totals.create, totals.bind, totals.skip))
        assertEquals(plan.asOf, rest.asOf)
        assertEquals(plan.truncated, rest.truncated)
        assertEquals(plan.unmatchedTeams, rest.unmatchedTeams)
        assertEquals(plan.vanished, rest.vanished)
        assertEquals(plan.ids(), plan.withoutRow("nothing").ids(), "an absent id drops nothing")
        assertNotNull(rest.row("2"))
        assertEquals(JiraImportAction.CREATE, rest.row("2").item.action)
    }

    private fun ch.nokillswit.jira.ImportRow.reason() = item.reason
}
