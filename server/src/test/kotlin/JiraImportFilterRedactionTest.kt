package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportFilter
import ch.nokillswit.jira.JiraImportItem
import ch.nokillswit.jira.JiraImportOverrides
import ch.nokillswit.jira.JiraImportPreview
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraImportScope
import ch.nokillswit.jira.JiraLevel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The order a non-admin's redacted rows come in under a filter: by what they still show, never by id (also used by the preview test). */
internal val SHOWN_ORDER = compareBy<JiraImportItem>(
    { it.level.ordinal }, { it.reason!!.ordinal }, { it.typeName.orEmpty() }, { it.hierarchyLevel ?: -1 },
)

/**
 * 1.13.2 audit LOW-1, end to end against the stub's `IMF` project: under an ACTIVE import filter a non-admin's redacted rows carry no
 * Jira key and no Jira id (the filter is a probe the caller steers; a key is the handle). An ADMIN, a preview with no (or an inactive)
 * filter and the apply are unchanged. A caller makes at most five calls a minute (the `jira-import` bucket); an apply creates the global
 * program names "IMF Program" and "IMF Program Old".
 */
class JiraImportFilterRedactionTest {
    private val both = JiraImportFilter(excludeDone = true, updatedWithinDays = 365)

    private fun deleteImfPrograms() {
        jbSql(
            "UPDATE programs SET marked_as_deleted = TRUE " +
                "WHERE LOWER(name) IN ('imf program', 'imf program old') AND NOT marked_as_deleted",
        )
    }

    private fun isRedacted(action: JiraImportAction, reason: JiraImportReason?) =
        action == JiraImportAction.SKIP && reason != JiraImportReason.ALREADY_BOUND

    @Test
    fun `under an active filter a non-admin's redacted rows carry no key and no Jira id and come last, an ADMIN sees all`() =
        testApplication {
            val a = importFixture("jifra", keys = listOf("IMF"))
            val b = planWorld("jifrb", teams = true)
            // IMF-1 is held by A's program: in B's stream it is ALREADY_BOUND (visible) and everything below it skips (redacted) - but
            // IMF-6 is held by a milestone of A, so it is ALREADY_BOUND too, and its Jira parent IMF-2 is a redacted row; IMF-7 is
            // ALREADY_BOUND as well and its parent IMF-3 (done) is not in the filtered browse at all (a linked child's parent is not read).
            a.w.admin.client.jbBind(a.connectionId, JiraLevel.PROGRAM, a.w.programId, "IMF-1").jbBinding()
            val milestone = TestPlan.milestone(a.w.projectId, a.defaultTeam)
            a.w.admin.client.jbBind(a.connectionId, JiraLevel.MILESTONE, milestone, "IMF-6").jbBinding()
            val other = TestPlan.milestone(a.w.projectId, a.defaultTeam)
            a.w.admin.client.jbBind(a.connectionId, JiraLevel.MILESTONE, other, "IMF-7").jbBinding()
            val scope = JiraImportScope(b.streamId, b.streamOwner.personId!!, null, null, true, both)
            val adminRows = a.w.admin.client.preview(a.connectionId, scope).previewBody().items
            assertEquals(adminRows.map { it.issueKey }.filterNotNull().size, adminRows.size, "an ADMIN's rows all carry their key")

            val response = b.streamOwner.client.preview(a.connectionId, scope)
            val text = response.bodyAsText()
            val owner = jbJson.decodeFromString<JiraImportPreview>(text).items
            assertEquals(HttpStatusCode.OK, response.status, text)
            assertEquals(adminRows.size, owner.size)
            // The redacted rows are listed by what they still show (level, reason, type), never by id: align the ADMIN's the same way.
            val hiddenAdmin = adminRows.filter { isRedacted(it.action, it.reason) }
                .sortedWith(SHOWN_ORDER)
            val visibleAdmin = adminRows.filterNot { isRedacted(it.action, it.reason) }
            val redactedIds = hiddenAdmin.map { it.jiraId }.toSet()
            assertTrue(hiddenAdmin.size >= 5, "most of the scope skips under the held program: ${hiddenAdmin.size}")
            val bound = visibleAdmin.single { it.issueKey == "IMF-6" }
            assertEquals(listOf(JiraImportReason.ALREADY_BOUND, "98002"), listOf(bound.reason, bound.parentJiraId), "ADMIN: parent shown")
            assertTrue(bound.parentJiraId in redactedIds)
            val absent = visibleAdmin.single { it.issueKey == "IMF-7" }
            assertEquals("98003", absent.parentJiraId, "ADMIN: the parent the filtered browse never listed")
            assertTrue(adminRows.none { it.issueKey == "IMF-3" })

            // The visible rows first, in the ADMIN's order and equal to its rows, except that an ALREADY_BOUND row names its parent only
            // when that is a visible row: a redacted parent and one the filtered browse never listed look alike (null).
            assertEquals(visibleAdmin.map { it.issueKey }, owner.take(visibleAdmin.size).map { it.issueKey })
            val visibleIds = visibleAdmin.map { it.jiraId }.toSet()
            visibleAdmin.forEachIndexed { index, admin ->
                val unnamed = admin.action == JiraImportAction.SKIP && admin.parentJiraId !in visibleIds
                val expected = if (unnamed) admin.copy(parentJiraId = null, parentIssueKey = null) else admin
                assertEquals(expected, owner[index], "a visible row is the ADMIN's row: ${admin.issueKey}")
            }
            // The redacted rows after them, numbered by their place in the list, handle-free.
            hiddenAdmin.forEachIndexed { index, admin ->
                val shown = owner[visibleAdmin.size + index]
                assertEquals("hidden-${visibleAdmin.size + index + 1}", shown.jiraId)
                assertNull(shown.issueKey)
                assertNull(shown.parentJiraId)
                assertNull(shown.parentIssueKey)
                assertEquals(listOf("", ""), listOf(shown.summary, shown.name))
                assertTrue(shown.infos.isEmpty() && shown.target == null && shown.team == null && shown.parent == null)
                assertEquals(listOf(admin.action, admin.reason, admin.level), listOf(shown.action, shown.reason, shown.level))
                assertEquals(listOf(admin.typeName, admin.hierarchyLevel), listOf(shown.typeName, shown.hierarchyLevel))
            }
            // On the wire: only the visible rows' keys and ids are in the body; no redacted row's key or id is, not even as a parent.
            val keys = visibleAdmin.map { it.issueKey }.filterNotNull().toSet()
            val ids = visibleAdmin.map { it.jiraId }.toSet()
            assertEquals(keys, Regex("IMF-[0-9]+").findAll(text).map { it.value }.toSet(), "keys in the body")
            assertEquals(ids, Regex("\"(98[0-9]{3})\"").findAll(text).map { it.groupValues[1] }.toSet(), "Jira ids in the body")
            val redactedKeys = hiddenAdmin.map { it.key() }
            assertTrue(redactedKeys.none { it in keys }, "no redacted key is among them: $redactedKeys")
        }

    @Test
    fun `with no filter, or an inactive one, a non-admin's redacted rows keep their key as before`() = testApplication {
        val a = importFixture("jifrc", keys = listOf("IMF"))
        val b = planWorld("jifrd", teams = true)
        a.w.admin.client.jbBind(a.connectionId, JiraLevel.PROGRAM, a.w.programId, "IMF-1").jbBinding()
        for (filter in listOf(null, JiraImportFilter(), JiraImportFilter(excludeDone = false, updatedWithinDays = null))) {
            val scope = JiraImportScope(b.streamId, b.streamOwner.personId!!, null, null, true, filter)
            val rows = b.streamOwner.client.preview(a.connectionId, scope).previewBody().items
            val redacted = rows.filter { isRedacted(it.action, it.reason) }
            assertTrue(redacted.size >= 5, "$filter: ${redacted.size}")
            assertTrue(redacted.all { it.issueKey != null && it.name == it.issueKey && it.summary == "" }, "$filter: $redacted")
            assertTrue(redacted.none { it.jiraId.startsWith("hidden-") }, "$filter")
        }
    }

    @Test
    fun `a non-admin's apply under the filter still writes their own rows, and a hidden id is not a tickable Jira id`() =
        testApplication {
            val f = importFixture("jifre", keys = listOf("IMF"))
            val admin = f.w.admin.client
            val owner = f.w.streamOwner.client
            try {
                val scope = f.scope(filter = both)
                val adminRows = admin.preview(f.connectionId, scope).previewBody().items
                val shown = owner.preview(f.connectionId, scope).previewBody()
                val hidden = shown.items.filter { it.issueKey == null }
                assertEquals(adminRows.count { isRedacted(it.action, it.reason) }, hidden.size)
                assertTrue(hidden.isNotEmpty(), "IMF-15 skips NO_PARENT")
                // The stream owner owns every target: all ten rows the ADMIN would write, none of them a hidden one.
                val ticks = shown.ticks()
                // A synthetic id is not a Jira id: ticking one is a 400 (the web never does: a redacted row has no checkbox).
                val bad = owner.applyImport(f.connectionId, scope, ticks + createTick(hidden.first().jiraId, JiraLevel.MILESTONE))
                assertEquals(HttpStatusCode.BadRequest, bad.status)
                val result = owner.applyImport(f.connectionId, scope, ticks).applyBody()
                assertEquals(10, result.created.size)
                assertTrue(result.skipped.isEmpty(), result.skipped.toString())
            } finally {
                deleteImfPrograms()
            }
        }

    @Test
    fun `an apply under the filter answers a tick of a redacted row like a vanished id, with no key`() = testApplication {
        val a = importFixture("jifrf", keys = listOf("IMF"))
        val b = planWorld("jifrg", teams = true)
        a.w.admin.client.jbBind(a.connectionId, JiraLevel.PROGRAM, a.w.programId, "IMF-1").jbBinding()
        val scope = JiraImportScope(b.streamId, b.streamOwner.personId!!, null, null, true, both)
        val hidden = a.w.admin.client.preview(a.connectionId, scope).previewBody().items.filter { isRedacted(it.action, it.reason) }
        assertTrue(hidden.size >= 5)
        // The bulk probe: the real ids (learnt from an unfiltered preview), a wrong expectation, one id the browse never holds - mixed
        // with a visible ALREADY_BOUND tick (IMF-1) and a visible CREATE ticked with a wrong expectation (IMF-12): they keep their key.
        val ticked = hidden.map { it.jiraId }.toMutableList().apply { add(2, "99999"); add(1, "98012"); add(4, "98001") }
        val ticks = ticked.map { createTick(it, JiraLevel.MILESTONE) }
        val response = b.streamOwner.client.applyImport(a.connectionId, scope, ticks)
        val text = response.bodyAsText()
        val result = jbJson.decodeFromString<ch.nokillswit.jira.JiraImportResult>(text)
        assertEquals(HttpStatusCode.OK, response.status, text)
        assertTrue(result.created.isEmpty() && result.bound.isEmpty())
        // The visible skips first, in row order; then the redacted ids and the vanished one in the order ticked, all alike.
        val concealed = ticked.filter { it != "98001" && it != "98012" }.map { Triple(it, null, JiraImportReason.CHANGED) }
        val visible = listOf(
            Triple("98001", "IMF-1", JiraImportReason.ALREADY_BOUND),
            Triple("98012", "IMF-12", JiraImportReason.CHANGED),
        )
        assertEquals(visible + concealed, result.skipped.map { Triple(it.jiraId, it.issueKey, it.reason) })
        assertEquals(setOf("IMF-1", "IMF-12"), Regex("IMF-[0-9]+").findAll(text).map { it.value }.toSet(), "only the visible keys")

        // An ADMIN gets the plain answer for the same ticks: the key and the kernel's own reason.
        val plain = a.w.admin.client.applyImport(a.connectionId, scope, ticks).applyBody().skipped.associateBy { it.jiraId }
        assertTrue(hidden.all { plain.getValue(it.jiraId).issueKey == it.issueKey && plain.getValue(it.jiraId).reason == it.reason })
    }

    @Test
    fun `an override cannot turn a redacted row into a CREATE, it is a keyless CHANGED whether or not it passes the filter`() =
        testApplication {
            val f = importFixture("jifrh", keys = listOf("IMF"))
            val other = secondProject(f.w, "jifrh2")
            // IMF-2 is linked to a project of the world's program that the project owner does not own: IMF-6 and IMF-11 (its epics) land
            // under it, and with no default team they are NO_TEAM, redacted in the preview. An override team would make them CREATEs under
            // an unowned project - a 403 naming the key, if the row passes the filter.
            f.w.admin.client.jbBind(f.connectionId, JiraLevel.PROJECT, other.projectId, "IMF-2").jbBinding()
            val defaults = JiraImportDefaults(projectId = f.w.projectId)
            val owner = f.w.projectOwner.client
            fun tick(id: String) = createTick(id, JiraLevel.MILESTONE, "98002").copy(overrides = JiraImportOverrides(f.defaultTeam))
            // 98009 is done and 98011 is quiet: the filter leaves them out (vanished); 98006 passes every filter.
            val ticks = listOf("98006", "98009", "98011").map(::tick)
            for (filter in listOf(both, JiraImportFilter(excludeDone = true))) {
                val scope = f.scope(defaults, filter = filter)
                val response = owner.applyImport(f.connectionId, scope, ticks)
                val text = response.bodyAsText()
                assertEquals(HttpStatusCode.OK, response.status, "$filter: $text")
                val result = jbJson.decodeFromString<ch.nokillswit.jira.JiraImportResult>(text)
                assertTrue(result.created.isEmpty() && result.bound.isEmpty(), "$filter: $text")
                val answer = result.skipped.map { Triple(it.jiraId, it.issueKey, it.reason) }
                assertEquals(listOf("98006", "98009", "98011").map { Triple(it, null, JiraImportReason.CHANGED) }, answer, "$filter")
                assertTrue(Regex("IMF-[0-9]+").findAll(text).none(), "$filter: no key")
            }
        }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
