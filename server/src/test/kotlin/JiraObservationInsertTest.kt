package ch.nokillswit

import ch.nokillswit.infra.crypto.DEV_DATA_ENCRYPTION_KEY
import ch.nokillswit.infra.crypto.FieldCipher
import ch.nokillswit.jira.JiraEstimateUnit
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraObservation
import ch.nokillswit.jira.JiraStatusCategory
import ch.nokillswit.jira.insertFirstObservation
import ch.nokillswit.jira.insertFirstObservations
import kotlinx.coroutines.runBlocking
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import java.math.BigDecimal
import java.time.LocalDate
import java.util.UUID
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * `insertFirstObservations` (the batch form the Jira import uses) writes every column `insertFirstObservation` writes: the same
 * observations go through both into different bindings and the whole stored rows are compared (`to_jsonb`, so a column added to one
 * writer and not the other is a difference, not a guess). One observation sets every nullable column, the other leaves them null.
 */
class JiraObservationInsertTest {
    private val connectionName = "obsins-${UUID.randomUUID().toString().take(8)}"

    private val full = JiraObservation(
        observedAt = 1_700_000_000_000L, issueId = "91001", issueKey = "OBS-1", summary = "A full observation", typeId = "10004",
        typeName = "Epic", hierarchyLevel = 1, statusName = "In progress", statusCategory = JiraStatusCategory.IN_PROGRESS,
        parentIssueId = "91000", parentIssueKey = "OBS-0", startDate = LocalDate.parse("2044-03-07"),
        endDate = LocalDate.parse("2044-03-18"), estimate = BigDecimal("5.50"), estimateUnit = JiraEstimateUnit.POINTS,
        teamName = "Obs Team", jiraUpdatedAt = 1_700_000_001_000L, gone = true, goneReason = "DELETED",
    )

    private val sparse = JiraObservation(
        observedAt = 1_700_000_002_000L, issueId = "91002", issueKey = "OBS-2", summary = null, typeId = null, typeName = null,
        hierarchyLevel = null, statusName = null, statusCategory = JiraStatusCategory.UNKNOWN, parentIssueId = null,
        parentIssueKey = null, startDate = null, endDate = null, estimate = null, estimateUnit = null, teamName = null,
        jiraUpdatedAt = null,
    )

    private fun scalarText(sql: String, vararg params: Any): String = jbScalar(sql, *params) { it.getString(1) }

    private fun storedRow(bindingId: UInt): String =
        scalarText("SELECT (to_jsonb(o) - 'binding_id')::text FROM jira_observations o WHERE binding_id = ?", bindingId.toInt())

    private fun connectionId(): UInt {
        val token = FieldCipher(DEV_DATA_ENCRYPTION_KEY).encrypt("x")
        return jbScalar(
            "INSERT INTO jira_connections (name, site_url, email, api_token, auth_scheme, project_keys, mapping, created_at, updated_at) " +
                "VALUES (?, 'https://obsins.atlassian.net', 'a@b.c', ?, 'BASIC', '[\"OBS\"]'::jsonb, '{}'::jsonb, 1, 1) RETURNING id",
            connectionName, token,
        ) { it.getInt(1) }.toUInt()
    }

    @AfterTest
    fun cleanUp() {
        val mine = "SELECT id FROM jira_connections WHERE name = ?"
        val bindings = "SELECT id FROM jira_bindings WHERE connection_id IN ($mine)"
        jbSql("DELETE FROM jira_observations WHERE binding_id IN ($bindings)", connectionName)
        jbSql("DELETE FROM jira_bindings WHERE connection_id IN ($mine)", connectionName)
        jbSql("DELETE FROM jira_connections WHERE name = ?", connectionName)
    }

    @Test
    fun `the batch insert stores every column the single-row insert stores`() = runBlocking {
        val owner = TestPeople.seed(planName("obs-owner"))
        val stream = TestPlan.workStream(owner)
        val programs = List(4) { TestPlan.program(stream, owner) }
        val connection = connectionId()
        val bindings = programs.mapIndexed { index, program ->
            dvBind(connection, JiraLevel.PROGRAM, program, "9200$index", "OBS-$index", obs = null)
        }
        val (single1, single2) = bindings.take(2)
        val (batch1, batch2) = bindings.drop(2)

        suspendTransaction(sharedDatabaseForTests()) {
            insertFirstObservation(single1, full)
            insertFirstObservation(single2, sparse)
            insertFirstObservations(listOf(batch1 to full, batch2 to sparse))
            insertFirstObservations(emptyList())
        }

        assertFalse(storedRow(single1).contains("null"), "the full observation sets every column: ${storedRow(single1)}")
        assertEquals(storedRow(single1), storedRow(batch1), "the batch writes the single-row insert's full row")
        assertEquals(storedRow(single2), storedRow(batch2), "the batch writes the single-row insert's sparse row")
    }
}
