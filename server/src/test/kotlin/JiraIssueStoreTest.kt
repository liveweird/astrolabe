package ch.nokillswit

import ch.nokillswit.infra.db.R2dbcDatabaseKey
import ch.nokillswit.jira.CensusIssue
import ch.nokillswit.jira.JiraIssueStore
import ch.nokillswit.jira.JiraStatusCategory
import ch.nokillswit.users.UserRole
import io.ktor.client.request.delete
import io.ktor.http.HttpStatusCode
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import io.ktor.server.testing.testApplication
import java.math.BigDecimal
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * The census mirror (V23) at its seam: `CensusIssue.of` fits a site's document to the columns (pure, no database), and `JiraIssueStore`
 * overwrites on the primary key, prunes by id, stamps `census_at` and writes nothing for a connection that is no longer active.
 */
class JiraIssueStoreTest {
    private fun issue(
        id: String = "501",
        key: String = "SP-501",
        summary: String = "Story",
        type: String = """{"id":"10004","name":"Epic"}""",
        status: String = """{"name":"Done","statusCategory":{"key":"done"}}""",
        points: String = "3",
        parent: String = """{"id":"500","key":"SP-500"}""",
    ): JsonObject = Json.parseToJsonElement(
        """{"id":"$id","key":"$key","fields":{"summary":"$summary","issuetype":$type,"status":$status,"parent":$parent,""" +
            """"customfield_10016":$points,"updated":"2026-03-02T10:00:00.000+0000"}}""",
    ) as JsonObject

    private fun of(doc: JsonObject) = CensusIssue.of(doc, DV_DISCOVERY, "customfield_10016", 7L)

    @Test
    fun `an issue document is fitted to the columns of the mirror`() {
        val row = assertNotNull(of(issue()))
        assertEquals(
            listOf("501", "SP-501", "10004", 1, "500"),
            listOf(row.issueId, row.issueKey, row.typeId, row.hierarchyLevel, row.parentIssueId),
        )
        assertEquals(JiraStatusCategory.DONE, row.statusCategory)
        assertEquals(BigDecimal("3.00"), row.points)
        assertEquals(7L, row.observedAt)
        assertNotNull(row.jiraUpdatedAt)

        val cut = assertNotNull(of(issue(summary = "x".repeat(300)))).summary
        assertEquals(255, cut?.length, "a 300-character summary is cut to the column")
        assertEquals("a b c", of(issue(summary = "a\\nb\\u0007c"))?.summary, "control characters become spaces")
        assertNull(of(issue(points = "1E10"))?.points, "a figure beyond NUMERIC(12,2) is not stored")
        assertNull(of(issue(points = "\"3\""))?.points, "a string is no figure")
        assertEquals(
            JiraStatusCategory.UNKNOWN,
            of(issue(status = """{"statusCategory":{"key":"weird"}}"""))?.statusCategory,
            "an unknown category key reads UNKNOWN",
        )
        assertNull(of(issue(id = "5x1")), "a non-digit id is no issue")
        assertNull(of(issue(key = "bad key")), "nor is an odd key")
        assertNull(of(issue(type = """{"id":"99999","name":"Mystery"}""")), "a type the discovery does not know has no level: no row")
        val own = assertNotNull(of(issue(type = """{"id":"99999","hierarchyLevel":7}""")))
        assertEquals(7, own.hierarchyLevel, "the issue's own level wins")
        assertNull(CensusIssue.of(issue(), DV_DISCOVERY, null, 7L)?.points, "no story-points field: no points")
        assertNull(of(issue(parent = "null"))?.parentIssueId)
    }

    private fun row(id: String, summary: String, level: Int = 0, status: JiraStatusCategory = JiraStatusCategory.TODO) =
        CensusIssue(id, "SP-$id", "10004", level, "500", summary, status, null, null, 7L)

    @Test
    fun `the store overwrites by primary key, prunes by id, stamps the census and skips a deleted connection`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jistore", UserRole.ADMIN)
        val connectionId = admin.dvConnection()
        val store = JiraIssueStore(application.attributes[R2dbcDatabaseKey])
        fun count() = jbScalar("SELECT count(*) FROM jira_issues WHERE connection_id = ?", connectionId.toInt()) { it.getInt(1) }
        fun summaryOf(id: String) = jbScalar(
            "SELECT summary FROM jira_issues WHERE connection_id = ? AND issue_id = ?", connectionId.toInt(), id,
        ) { it.getString(1) }

        assertEquals(0, store.upsert(connectionId, emptyList()))
        assertEquals(3, store.upsert(connectionId, listOf(row("1", "one"), row("2", "two"), row("3", "three", level = 1))))
        assertEquals(mapOf("1" to 0, "2" to 0, "3" to 1), store.index(connectionId))
        store.upsert(connectionId, listOf(row("2", "two again", status = JiraStatusCategory.DONE)))
        assertEquals("two again", summaryOf("2"), "an upsert overwrites the row")
        assertEquals(3, count(), "and adds none")
        assertEquals(2, store.delete(connectionId, listOf("1", "3", "404")), "delete by ids removes what exists")
        assertEquals(0, store.delete(connectionId, emptyList()))
        assertEquals(setOf("2"), store.index(connectionId).keys)

        assertNull(store.censusAt(connectionId), "never censused")
        assertEquals(true, store.stampCensus(connectionId, 1234L))
        assertEquals(1234L, store.censusAt(connectionId))

        assertEquals(HttpStatusCode.NoContent, admin.delete("$JB_CONNECTIONS/$connectionId").status)
        assertEquals(0, count(), "the connection's delete took its mirror")
        assertEquals(0, store.upsert(connectionId, listOf(row("9", "late"))), "a run's late write finds no active connection")
        assertEquals(0, count())
        assertEquals(false, store.stampCensus(connectionId, 5L))
        assertNull(store.censusAt(connectionId))
    }

    @Test
    fun `an upsert that waits behind a delete's row lock finds the connection gone and writes nothing`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("jistorerace", UserRole.ADMIN)
        val connectionId = admin.dvConnection()
        val store = JiraIssueStore(application.attributes[R2dbcDatabaseKey])
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            // The lock JiraConnectionService.delete holds: the upsert's FOR SHARE must wait behind it.
            raw.prepareStatement("SELECT id FROM jira_connections WHERE id = ? FOR NO KEY UPDATE").use { st ->
                st.setInt(1, connectionId.toInt())
                st.executeQuery().close()
            }
            try {
                val written = coroutineScope {
                    val pending = async { store.upsert(connectionId, listOf(row("1", "late"))) }
                    awaitLockWait("FOR SHARE")
                    assertFalse(pending.isCompleted, "the upsert is held at the connection row")
                    raw.exec("UPDATE jira_connections SET marked_as_deleted = TRUE, api_token = NULL WHERE id = ?", connectionId.toInt())
                    raw.commit()
                    pending.await()
                }
                assertEquals(0, written, "the delete won: the write is skipped")
            } finally {
                raw.rollback()
            }
        }
        assertEquals(
            0,
            jbScalar("SELECT count(*) FROM jira_issues WHERE connection_id = ?", connectionId.toInt()) { it.getInt(1) },
            "no mirror row outlives its connection",
        )
    }
}
