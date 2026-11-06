package ch.nokillswit

import ch.nokillswit.infra.crypto.DEV_DATA_ENCRYPTION_KEY
import ch.nokillswit.infra.crypto.FieldCipher
import kotlinx.coroutines.runBlocking
import java.sql.SQLException
import java.util.UUID
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The V21 tables at the database (raw JDBC, no routes: only the connection registry has code in 1.1.0 step C2; bindings, observations
 * and runs arrive with their own steps and rely on exactly these constraints): every CHECK, the partial unique indexes and the foreign
 * keys, by SQLSTATE. Rows are unique per test; the shared tables are never emptied.
 */
class JiraSchemaTest {
    private companion object {
        const val CHECK = "23514"
        const val UNIQUE = "23505"
        const val FOREIGN_KEY = "23503"
    }

    // A real envelope under the suite's key: a plaintext row would be wrapped (or fail a rotation) by the next boot in this fork.
    private val token = FieldCipher(DEV_DATA_ENCRYPTION_KEY).encrypt("x")

    private fun unique(prefix: String) = "$prefix-${UUID.randomUUID().toString().substring(0, 8)}"

    /** Runs [sql] on its own connection (autocommit); `null` on success, else the SQLSTATE. */
    private fun sqlState(sql: String): String? = PostgresTestSupport.connect().use { connection ->
        try {
            connection.createStatement().use { it.executeUpdate(sql) }
            null
        } catch (e: SQLException) {
            e.sqlState
        }
    }

    private fun int(sql: String): Int = PostgresTestSupport.connect().use { connection ->
        connection.createStatement().use { st -> st.executeQuery(sql).use { rs -> rs.next(); rs.getInt(1) } }
    }

    private fun connection(
        name: String = unique("schema"),
        authScheme: String = "BASIC",
        keys: String = """["SP"]""",
        mapping: String = "{}",
    ): String = "INSERT INTO jira_connections " +
        "(name, site_url, email, api_token, auth_scheme, project_keys, mapping, created_at, updated_at) " +
        "VALUES ('$name', 'https://sample.atlassian.net', 'a@b.c', '$token', '$authScheme', '$keys'::jsonb, '$mapping'::jsonb, 1, 1)"

    /**
     * Removes every row this class created (connections named `schema-*` and what hangs off them, children first), so the shared tables
     * keep no fixture rows for later tests or rotating boots.
     */
    private fun removeRows() = PostgresTestSupport.connect().use { connection ->
        val mine = "SELECT id FROM jira_connections WHERE name LIKE 'schema-%'"
        val bindings = "SELECT id FROM jira_bindings WHERE connection_id IN ($mine)"
        connection.createStatement().use { st ->
            st.executeUpdate("DELETE FROM jira_observations WHERE binding_id IN ($bindings)")
            st.executeUpdate("DELETE FROM jira_bindings WHERE connection_id IN ($mine)")
            st.executeUpdate("DELETE FROM sync_runs WHERE connection_id IN ($mine)")
            st.executeUpdate("DELETE FROM jira_connections WHERE name LIKE 'schema-%'")
        }
    }

    @AfterTest
    fun cleanUp() {
        removeRows()
    }

    private fun newConnection(): Int = PostgresTestSupport.connect().use { c ->
        c.createStatement().use { st ->
            st.executeQuery(connection() + " RETURNING id").use { rs -> rs.next(); rs.getInt(1) }
        }
    }

    @Test
    fun `a connection's CHECKs and its partial name index hold`() {
        PostgresTestSupport.ensureMigrated()
        assertNull(sqlState(connection()))
        assertEquals(CHECK, sqlState(connection(authScheme = "NTLM")), "auth scheme is BASIC or BEARER")
        assertEquals(CHECK, sqlState(connection(keys = "[]")), "at least one project key")
        assertEquals(CHECK, sqlState(connection(keys = (1..51).joinToString(",", "[", "]") { "\"K$it\"" })), "at most 50 project keys")
        assertEquals(CHECK, sqlState(connection(keys = """{"SP": 1}""")), "the keys are an array")
        assertEquals(CHECK, sqlState(connection(mapping = "[]")), "the mapping is an object")
        val name = unique("schema-dup")
        assertNull(sqlState(connection(name = name)))
        assertEquals(UNIQUE, sqlState(connection(name = name.uppercase())), "the active name is unique case-insensitively")
        assertNull(sqlState("UPDATE jira_connections SET marked_as_deleted = TRUE WHERE name = '$name'"))
        assertNull(sqlState(connection(name = name)), "a deleted connection frees its name")
    }

    @Test
    fun `a binding names exactly one node of its level and is one-to-one both ways`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val owner = TestPeople.seed(unique("owner"))
        val program = TestPlan.program(TestPlan.workStream(owner), owner)
        val project = TestPlan.project(program, owner)
        val team = TestTeams.seed(unique("team"))
        val milestone = TestPlan.milestone(project, team)
        val milestone2 = TestPlan.milestone(project, team)
        val c = newConnection()
        val other = newConnection()

        fun bind(
            level: String,
            programId: String = "NULL",
            projectId: String = "NULL",
            milestoneId: String = "NULL",
            issue: String = unique("1"),
            connectionId: Int = c,
        ) =
            sqlState(
                "INSERT INTO jira_bindings (connection_id, level, program_id, project_id, milestone_id, " +
                    "jira_issue_id, jira_issue_key, created_at, updated_at) " +
                    "VALUES ($connectionId, '$level', $programId, $projectId, $milestoneId, '$issue', 'SP-1', 1, 1)",
            )

        assertEquals(CHECK, bind("EPIC", milestoneId = "$milestone"), "an unknown level")
        assertEquals(CHECK, bind("MILESTONE"), "no node set")
        assertEquals(CHECK, bind("MILESTONE", milestoneId = "$milestone", projectId = "$project"), "two nodes set")
        assertEquals(CHECK, bind("PROJECT", milestoneId = "$milestone"), "the node does not match the level")
        assertEquals(FOREIGN_KEY, bind("MILESTONE", milestoneId = "999999999"), "the node must exist")
        assertEquals(FOREIGN_KEY, bind("MILESTONE", milestoneId = "$milestone", connectionId = 999999999), "the connection must exist")

        assertNull(bind("PROGRAM", programId = "$program", issue = "10"))
        assertNull(bind("PROJECT", projectId = "$project", issue = "11"))
        assertNull(bind("MILESTONE", milestoneId = "$milestone", issue = "12"))
        // A node carries one active binding (NULLS NOT DISTINCT: the two unused node columns are NULL and still collide).
        assertEquals(UNIQUE, bind("MILESTONE", milestoneId = "$milestone", issue = "13"))
        assertEquals(UNIQUE, bind("PROGRAM", programId = "$program", issue = "14"))
        // An issue is bound once per connection ...
        assertEquals(UNIQUE, bind("MILESTONE", milestoneId = "$milestone2", issue = "12"))
        // ... and may be bound again on another connection.
        assertNull(bind("MILESTONE", milestoneId = "$milestone2", issue = "12", connectionId = other))
        // Unbinding (soft delete) frees both the node and the issue; the history row stays.
        assertNull(sqlState("UPDATE jira_bindings SET marked_as_deleted = TRUE WHERE milestone_id = $milestone"))
        assertNull(bind("MILESTONE", milestoneId = "$milestone", issue = "12x"))
        assertEquals(2, int("SELECT count(*) FROM jira_bindings WHERE milestone_id = $milestone"))
    }

    @Test
    fun `an observation is one row per binding with a closed vocabulary`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val owner = TestPeople.seed(unique("owner"))
        val program = TestPlan.program(TestPlan.workStream(owner), owner)
        val c = newConnection()
        val binding = PostgresTestSupport.connect().use { conn ->
            conn.createStatement().use { st ->
                st.executeQuery(
                    "INSERT INTO jira_bindings (connection_id, level, program_id, jira_issue_id, jira_issue_key, created_at, updated_at) " +
                        "VALUES ($c, 'PROGRAM', $program, '77', 'SP-77', 1, 1) RETURNING id",
                ).use { rs -> rs.next(); rs.getInt(1) }
            }
        }

        fun observe(
            id: Int,
            statusCategory: String? = "DONE",
            goneReason: String? = null,
            start: String = "2026-03-02",
            end: String = "2026-03-01",
        ) =
            sqlState(
                "INSERT INTO jira_observations (binding_id, observed_at, status_category, gone_reason, start_date, end_date) " +
                    "VALUES ($id, 1, ${statusCategory?.let { "'$it'" }}, ${goneReason?.let { "'$it'" }}, '$start', '$end')",
            )

        assertEquals(FOREIGN_KEY, observe(999999999))
        assertEquals(CHECK, observe(binding, statusCategory = "WAITING"))
        assertEquals(CHECK, observe(binding, goneReason = "MOVED"))
        // Jira's own dates are stored as observed: an end before the start is data (a deviation), not a constraint violation.
        assertNull(observe(binding))
        assertEquals(UNIQUE, observe(binding), "one latest row per binding")
    }

    @Test
    fun `a connector has at most one unfinished run and a closed vocabulary`() {
        PostgresTestSupport.ensureMigrated()
        val c = newConnection()
        val other = newConnection()

        fun run(connection: Int, kind: String = "JIRA", trigger: String = "MANUAL", finished: String = "NULL", outcome: String = "NULL") =
            sqlState(
                "INSERT INTO sync_runs (kind, connection_id, \"trigger\", started_at, finished_at, outcome) " +
                    "VALUES ('$kind', $connection, '$trigger', 1, $finished, $outcome)",
            )

        assertEquals(CHECK, run(c, kind = "GITLAB"))
        assertEquals(CHECK, run(c, trigger = "WEBHOOK"))
        assertEquals(CHECK, run(c, finished = "2", outcome = "'CRASHED'"))
        assertNull(run(c))
        assertEquals(UNIQUE, run(c, trigger = "SCHEDULED"), "the single-writer claim: one unfinished run per (kind, connection)")
        assertNull(run(other), "another connection claims independently")
        assertNull(run(c, kind = "FLOW"), "another kind claims independently")
        assertNull(sqlState("UPDATE sync_runs SET finished_at = 2, outcome = 'SUCCEEDED' WHERE connection_id = $c AND kind = 'JIRA'"))
        assertNull(run(c, trigger = "SCHEDULED"), "a finished run releases the claim")
        assertNull(run(c, finished = "3", outcome = "'ABANDONED'"), "finished runs pile up as history")
    }
}
