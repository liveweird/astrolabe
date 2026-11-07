package ch.nokillswit

import ch.nokillswit.jira.ApplyContext
import ch.nokillswit.jira.ImportOutcome
import ch.nokillswit.jira.JiraConnectionServiceKey
import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportApplyItem
import ch.nokillswit.jira.JiraImportApplyRequest
import ch.nokillswit.jira.JiraImportExpected
import ch.nokillswit.jira.JiraImportExpectedParent
import ch.nokillswit.jira.JiraImportOverrides
import ch.nokillswit.jira.JiraImportParentKind
import ch.nokillswit.jira.JiraImportServiceKey
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.browseGuard
import ch.nokillswit.jira.browseScope
import ch.nokillswit.jira.effectiveMapping
import io.ktor.server.testing.ApplicationTestBuilder
import kotlin.test.assertEquals

// The plan-sized Jira world the scale tests share (`JiraImportScaleTest`, `JiraFlagsScaleTest`): a scripted Jira site (a Ktor MockEngine
// under the real client) answers programs, projects and milestones whose parents chain up, and ONE import apply writes them with their
// bindings and observations. Nothing here reads the Jira stub; the fixture does (`importFixture`).

/** The id of the first milestone issue: milestone number `n` (1-based) is issue `MILESTONE_ISSUE_BASE + n`. */
internal const val MILESTONE_ISSUE_BASE = 400_000

/** The issue documents of a scope: [programs] programs, [projects] projects spread over them, [milestones] dated milestones over those. */
internal fun scaleDocs(tag: String, programs: Int, projects: Int, milestones: Int): List<String> {
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
            "${MILESTONE_ISSUE_BASE + it}", "IMP-${MILESTONE_ISSUE_BASE + it}", "10004", "Epic", 1, "$tag Milestone $it",
            parent(project, "$project", "10005", "Initiative", 2) + "," + dates,
        )
    }
    return programDocs + projectDocs + milestoneDocs
}

/** What [applyScaleImport] did: the apply's [created] outcome, the revision [revisionBefore] it started from, its lock hold [millis]. */
internal class ScaleImport(val created: ImportOutcome, val revisionBefore: Long, val millis: Double)

/**
 * Applies the [scaleDocs] world through ONE `JiraImportService.apply` (the timed span is the lock hold, the browse is outside it).
 * [teamOf] picks each milestone's team from its 1-based number; the default is the fixture's team for every milestone.
 */
internal suspend fun ApplicationTestBuilder.applyScaleImport(
    f: ImportFixture,
    tag: String,
    programs: Int,
    projects: Int,
    milestones: Int,
    teamOf: (Int) -> UInt = { f.defaultTeam },
): ScaleImport {
    val all = scaleDocs(tag, programs, projects, milestones)
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
        // The preview would have planned the default team; a different team is the row's override.
        val team = f.defaultTeam.takeIf { level == JiraLevel.MILESTONE }
        val wanted = teamOf(it.observation.issueId.toInt() - MILESTONE_ISSUE_BASE)
        val chosen = wanted.takeIf { level == JiraLevel.MILESTONE && wanted != team }
        val expected = JiraImportExpected(JiraImportAction.CREATE, level, it.observation.parentIssueId, null, landing, team)
        JiraImportApplyItem(it.observation.issueId, expected, chosen?.let(::JiraImportOverrides))
    }
    val scope = f.scope()
    val request = JiraImportApplyRequest(scope.workStreamId, scope.ownerPersonId, null, scope.defaults, true, ticks)
    val before = TestPlan.revision()
    val admin = f.w.admin
    val applied = ApplyContext(
        f.connectionId, request, listOf("IMP"), browse, mapping, discovery, context.mappingChangedAt,
        ch.nokillswit.authz.CallerPrincipal(admin.userId, "admin@scale.test", setOf(ch.nokillswit.users.UserRole.ADMIN)), { null }, 1L,
    )
    val started = System.nanoTime()
    val created = application.attributes[JiraImportServiceKey].apply(applied)
    return ScaleImport(created, before, (System.nanoTime() - started) / NANOS_PER_MILLI)
}

/** Hard-deletes what the import wrote (bindings and observations first: they reference the nodes), found by this run's unique tag. */
internal fun removeScaleRows(connectionId: UInt, tag: String) {
    val like = "$tag %"
    val bindings = "SELECT id FROM jira_bindings WHERE connection_id = ${connectionId.toInt()}"
    jbSql("DELETE FROM jira_observations WHERE binding_id IN ($bindings)")
    jbSql("DELETE FROM jira_bindings WHERE connection_id = ?", connectionId.toInt())
    jbSql("DELETE FROM milestones WHERE name LIKE ?", like)
    jbSql("DELETE FROM projects WHERE name LIKE ?", like)
    jbSql("DELETE FROM programs WHERE name LIKE ?", like)
}

private const val NANOS_PER_MILLI = 1_000_000.0
