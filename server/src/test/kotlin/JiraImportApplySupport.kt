package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportApplyItem
import ch.nokillswit.jira.JiraImportApplyRequest
import ch.nokillswit.jira.JiraImportExpected
import ch.nokillswit.jira.JiraImportExpectedParent
import ch.nokillswit.jira.JiraImportParentKind
import ch.nokillswit.jira.JiraImportPreview
import ch.nokillswit.jira.JiraImportResult
import ch.nokillswit.jira.JiraImportScope
import ch.nokillswit.jira.JiraLevel
import io.ktor.client.HttpClient
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import kotlin.test.assertEquals

// Helpers of the Jira import's apply tests (`JiraImportApply*Test`). The stub's `IMP` project is 1 program, 2 initiatives and 6 epics with
// the ids 95001..95009 (IMP-n = 95000 + n); program names are GLOBALLY unique, so a test that lets the apply create "IMP Program" must
// call [deleteImpProgram] in a `finally` (`JiraImportPreviewTest` expects IMP-1 to be a CREATE, and class order is no contract) - or
// bind the world's own program to IMP-1 first, which creates no program at all ([ImportFixture.bindImpProgram]).

/** `POST …/connections/{id}/import`, the scope's members flat and the [items] ticked. */
internal suspend fun HttpClient.applyImport(id: UInt, scope: JiraImportScope, items: List<JiraImportApplyItem>): HttpResponse =
    postJson(
        "$JB_CONNECTIONS/$id/import",
        JiraImportApplyRequest(
            scope.workStreamId, scope.ownerPersonId, scope.projectKeys, scope.defaults, scope.copyDates, items, scope.filter, scope.root,
        ),
    )

internal suspend fun HttpResponse.applyBody(): JiraImportResult {
    assertEquals(HttpStatusCode.OK, status, bodyAsText())
    return jbJson.decodeFromString(bodyAsText())
}

/** The ticks of a preview: every CREATE and BIND row, each expecting exactly what the preview showed, except the [leaveOut] keys. */
internal fun JiraImportPreview.ticks(vararg leaveOut: String): List<JiraImportApplyItem> =
    items.filter { it.action != JiraImportAction.SKIP && it.issueKey !in leaveOut }.map { it.tick() }

internal fun ch.nokillswit.jira.JiraImportItem.tick() =
    JiraImportApplyItem(
        jiraId,
        JiraImportExpected(
            action, level, parentJiraId, target?.nodeId, parent?.let { JiraImportExpectedParent(it.kind, it.nodeId) },
            team?.id.takeIf { level == JiraLevel.MILESTONE && action == JiraImportAction.CREATE },
        ),
    )

/** A stale client's tick: it expects a CREATE of [level] under [parentJiraId] (what a preview showed before the plan or the site moved). */
internal fun createTick(jiraId: String, level: JiraLevel, parentJiraId: String? = null, teamId: UInt? = null) =
    JiraImportApplyItem(
        jiraId,
        JiraImportExpected(
            JiraImportAction.CREATE, level, parentJiraId, null,
            JiraImportExpectedParent(JiraImportParentKind.NEW_ROW).takeIf { level != JiraLevel.PROGRAM }, teamId,
        ),
    )

/** Soft-deletes the active "IMP Program" (the global name an apply of `IMP-1` creates). */
internal fun deleteImpProgram() {
    jbSql("UPDATE programs SET marked_as_deleted = TRUE WHERE LOWER(name) = 'imp program' AND NOT marked_as_deleted")
}

/** Binds the world's own program to `IMP-1`: the import then creates no program, and its projects land under the world's program. */
internal suspend fun ImportFixture.bindImpProgram() {
    w.admin.client.jbBind(connectionId, JiraLevel.PROGRAM, w.programId, "IMP-1").jbBinding()
}

internal fun activeBindingCount(connectionId: UInt): Int =
    jbScalar("SELECT count(*) FROM jira_bindings WHERE connection_id = ? AND NOT marked_as_deleted", connectionId.toInt()) { it.getInt(1) }
