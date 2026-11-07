package ch.nokillswit

import ch.nokillswit.jira.ApplyContext
import ch.nokillswit.jira.JiraConnectionServiceKey
import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportApplyItem
import ch.nokillswit.jira.JiraImportApplyRequest
import ch.nokillswit.jira.JiraImportExpected
import ch.nokillswit.jira.JiraImportExpectedParent
import ch.nokillswit.jira.JiraImportParentKind
import ch.nokillswit.jira.JiraImportServiceKey
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.browseGuard
import ch.nokillswit.jira.browseScope
import ch.nokillswit.jira.effectiveMapping
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The lock hold of the apply at scale, measured: a scripted Jira site (a Ktor MockEngine under the real client) answers a plan-sized scope
 * - 20 programs, 100 projects, 1,000 milestones, every milestone dated - and the apply writes it in ONE plan write. The timed span is
 * `JiraImportService.apply` from the lock request to the commit: exactly how long every other plan writer waits (the browse is outside
 * it). The figure is a `scale-figure` line ([ScaleFigures]) and is recorded in `build-times.md`; the bound asserted here is a loose
 * tripwire. The rows are removed in a `NonCancellable` `finally`.
 */
class JiraImportScaleTest {
    private fun docs(tag: String, programs: Int, projects: Int, milestones: Int): List<String> {
        fun parent(id: Int, key: String, typeId: String, name: String, level: Int) =
            """"parent":{"id":"$id","key":"IMP-$key","fields":{"issuetype":{"id":"$typeId","name":"$name","hierarchyLevel":$level}}}"""
        val dates = """"customfield_10022":"2045-01-02","customfield_10023":"2045-01-06""""
        val programDocs = (1..programs).map {
            issueDoc("${200_000 + it}", "IMP-${200_000 + it}", "10006", "Program", 3, "$tag Program $it")
        }
        val projectDocs = (1..projects).map {
            val program = 200_000 + (it - 1) % programs + 1
            val up = parent(program, "$program", "10006", "Program", 3)
            issueDoc("${300_000 + it}", "IMP-${300_000 + it}", "10005", "Initiative", 2, "$tag Project $it", up)
        }
        val milestoneDocs = (1..milestones).map {
            val project = 300_000 + (it - 1) % projects + 1
            issueDoc(
                "${400_000 + it}", "IMP-${400_000 + it}", "10004", "Epic", 1, "$tag Milestone $it",
                parent(project, "$project", "10005", "Initiative", 2) + "," + dates,
            )
        }
        return programDocs + projectDocs + milestoneDocs
    }

    private suspend fun ApplicationTestBuilder.measure(label: String, programs: Int, projects: Int, milestones: Int) {
        val f = importFixture("jisc$label")
        val tag = planName("sc$label")
        val all = docs(tag, programs, projects, milestones)
        val pages = all.chunked(100).mapIndexed { i, page ->
            searchPage(*page.toTypedArray(), next = if ((i + 1) * 100 < all.size) "T${i + 2}" else null)
        }
        val site = ScriptedSite(*pages.toTypedArray())
        val connections = application.attributes[JiraConnectionServiceKey]
        val context = checkNotNull(connections.readForBind(f.connectionId))
        val discovery = checkNotNull(context.state.discovery)
        val mapping = effectiveMapping(context.state, discovery)
        val browse = browseScope(
            site.connector, context, checkNotNull(context.target.apiToken), listOf("IMP"), mapping, discovery, 1L,
            browseGuard(connections, f.connectionId),
        )
        assertEquals(all.size, browse.issues.size)
        val levels = mapOf("10006" to JiraLevel.PROGRAM, "10005" to JiraLevel.PROJECT, "10004" to JiraLevel.MILESTONE)
        val ticks = browse.issues.map {
            val level = levels.getValue(checkNotNull(it.observation.typeId))
            val landing = JiraImportExpectedParent(JiraImportParentKind.NEW_ROW).takeIf { level != JiraLevel.PROGRAM }
            val team = f.defaultTeam.takeIf { level == JiraLevel.MILESTONE }
            val expected = JiraImportExpected(JiraImportAction.CREATE, level, it.observation.parentIssueId, null, landing, team)
            JiraImportApplyItem(it.observation.issueId, expected)
        }
        val scope = f.scope()
        val request = JiraImportApplyRequest(scope.workStreamId, scope.ownerPersonId, null, scope.defaults, true, ticks)
        val imports = application.attributes[JiraImportServiceKey]
        val before = TestPlan.revision()
        val admin = f.w.admin
        val applied = ApplyContext(
            f.connectionId, request, listOf("IMP"), browse, mapping, discovery, context.mappingChangedAt,
            ch.nokillswit.authz.CallerPrincipal(admin.userId, "admin@scale.test", setOf(ch.nokillswit.users.UserRole.ADMIN)), { null }, 1L,
        )
        try {
            lateinit var created: ch.nokillswit.jira.ImportOutcome
            val started = System.nanoTime()
            created = imports.apply(applied)
            val millis = (System.nanoTime() - started) / NANOS_PER_MILLI
            assertEquals(all.size, created.result.created.size)
            assertEquals(before + 1, created.result.revision)
            assertEquals(milestones, created.result.created.count { it.scheduled })
            ScaleFigures.print("jira-import apply $label ($programs/$projects/$milestones)", millis)
            assertTrue(millis <= TRIPWIRE_MS, "the apply held the plan lock for $millis ms")
        } finally {
            // NonCancellable: a test cancelled by the 60 s limit must still take its thousands of rows out of the shared plan.
            withContext(NonCancellable) { removeImported(f.connectionId, tag) }
        }
    }

    /** Hard-deletes what the import wrote (bindings and observations first: they reference the nodes), found by this run's unique tag. */
    private fun removeImported(connectionId: UInt, tag: String) {
        val like = "$tag %"
        val bindings = "SELECT id FROM jira_bindings WHERE connection_id = ${connectionId.toInt()}"
        jbSql("DELETE FROM jira_observations WHERE binding_id IN ($bindings)")
        jbSql("DELETE FROM jira_bindings WHERE connection_id = ?", connectionId.toInt())
        jbSql("DELETE FROM milestones WHERE name LIKE ?", like)
        jbSql("DELETE FROM projects WHERE name LIKE ?", like)
        jbSql("DELETE FROM programs WHERE name LIKE ?", like)
    }

    @Test
    fun `the plan-sized import - 20 programs, 100 projects, 1,000 milestones - holds the lock for seconds at most`() = testApplication {
        measure("plan", 20, 100, 1_000)
    }

    @Test
    fun `an import at the 2,000-item cap holds the plan lock for seconds at most`() = testApplication {
        measure("cap", 20, 100, 1_880)
    }

    companion object {
        /** Loose: at least 5x the figure measured on the dev machine (about 1 s and 2 s), so a slower runner never flakes it. */
        private const val TRIPWIRE_MS = 10_000.0
        private const val NANOS_PER_MILLI = 1_000_000.0


        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
