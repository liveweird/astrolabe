package ch.nokillswit

import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportParentKind
import ch.nokillswit.jira.JiraImportReason
import ch.nokillswit.jira.JiraLevel
import com.github.tomakehurst.wiremock.client.WireMock.aResponse
import com.github.tomakehurst.wiremock.client.WireMock.get
import com.github.tomakehurst.wiremock.client.WireMock.urlPathMatching
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The snapshot's holder rules against the database (D1: an issue is held once across the connections of a SITE): another connection of
 * the site blocks even disabled and with a differently-cased `site_url`; a soft-deleted connection's binding does not; a binding whose
 * node was deleted does not block (the apply would release it); and a holder of the Jira PARENT of a browsed issue is found although the
 * parent is not in the browse (the issue ids handed to the snapshot include the parents'). Everything binds on the fixture's private site.
 */
class JiraImportPreviewSnapshotTest {
    @Test
    fun `holders on the site decide the rows, whichever connection holds them, and an unbrowsed parent is found`() = testApplication {
        val f = importFixture("jipd1")
        val admin = f.w.admin.client
        val other = admin.jbConnection(jbRequest(f.site, keys = listOf("IMP")))
        val ghost = admin.jbConnection(jbRequest(f.site, keys = listOf("IMP")))
        val (m4, m5, m6) = List(3) { TestPlan.milestone(f.w.projectId, f.defaultTeam) }
        admin.jbBind(other.id, JiraLevel.MILESTONE, m4, "IMP-4").jbBinding()
        admin.jbBind(ghost.id, JiraLevel.MILESTONE, m5, "IMP-5").jbBinding()
        admin.jbBind(f.connectionId, JiraLevel.MILESTONE, m6, "IMP-6").jbBinding()
        admin.jbBind(f.connectionId, JiraLevel.PROJECT, f.w.projectId, "IMP-2").jbBinding()
        // Another connection of the site, DISABLED and with the host in upper case: it still holds IMP-4.
        val upper = f.site.replace(Regex("//([^.]+)")) { "//" + it.groupValues[1].uppercase() }
        jbSql("UPDATE jira_connections SET enabled = false, site_url = ? WHERE id = ?", upper, other.id.toInt())
        // A soft-deleted connection whose binding row is still active (the delete route would have released it): not a holder.
        jbSql("UPDATE jira_connections SET marked_as_deleted = true, api_token = NULL WHERE id = ?", ghost.id.toInt())
        // A binding whose node is gone: not a holder either.
        jbSql("UPDATE milestones SET marked_as_deleted = true WHERE id = ?", m6.toInt())

        val rows = admin.preview(f.connectionId, f.scope()).previewBody().items.associateBy { it.issueKey }
        val held = rows.getValue("IMP-4")
        assertEquals(listOf(JiraImportAction.SKIP, JiraImportReason.ALREADY_BOUND), listOf(held.action, held.reason))
        assertEquals(listOf(m4, other.id, JiraLevel.MILESTONE), held.target!!.let { listOf(it.nodeId, it.connectionId, it.nodeKind) })
        val freed = rows.getValue("IMP-5")
        assertEquals(listOf(JiraImportAction.CREATE, null), listOf(freed.action, freed.reason), "a deleted connection holds nothing")
        // IMP-2 is bound to the live project, so IMP-5 lands under that existing node.
        assertEquals(listOf(JiraImportParentKind.EXISTING, f.w.projectId), freed.parent!!.let { listOf(it.kind, it.nodeId) })
        val released = rows.getValue("IMP-6")
        assertEquals(listOf(JiraImportAction.CREATE, null), listOf(released.action, released.reason), "a dead node holds nothing")
        assertNull(rows.getValue("IMP-6").target)

        // A browse of one Epic whose Initiative parent (IMP-2, bound above) is NOT in the browse: the parent's holder is still read.
        val parent = """"parent":{"id":"95002","key":"IMP-2","fields":{"issuetype":{"id":"10005","name":"Initiative"}}}"""
        val marker = get(urlPathMatching(".*/rest/api/3/search/jql")).atPriority(1)
            .willReturn(aResponse().withStatus(200).withBody(searchPage(issueDoc("99999", "IMP-77", level = 1, fields = parent))))
        val registered = JiraStubServer.addOverride(marker)
        try {
            val only = admin.preview(f.connectionId, f.scope()).previewBody().items.single()
            assertEquals(listOf("IMP-77", JiraImportAction.CREATE), listOf(only.issueKey, only.action))
            assertEquals(listOf(JiraImportParentKind.EXISTING, f.w.projectId), only.parent!!.let { listOf(it.kind, it.nodeId) })
        } finally {
            JiraStubServer.removeOverride(registered)
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
