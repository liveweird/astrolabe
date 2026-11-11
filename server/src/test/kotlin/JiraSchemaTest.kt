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
        const val TOO_LONG = "22001"
        const val NOT_NULL = "23502"
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
            st.executeUpdate("DELETE FROM jira_deviation_acknowledgements WHERE binding_id IN ($bindings)")
            st.executeUpdate("DELETE FROM jira_observations WHERE binding_id IN ($bindings)")
            st.executeUpdate("DELETE FROM jira_bindings WHERE connection_id IN ($mine)")
            st.executeUpdate("DELETE FROM sync_runs WHERE connection_id IN ($mine)")
            st.executeUpdate("DELETE FROM jira_issues WHERE connection_id IN ($mine)")
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
    fun `the polling interval defaults to 15 and is NULL or between 5 and 1440`() {
        PostgresTestSupport.ensureMigrated()
        fun withInterval(value: String?, name: String = unique("schema")): String {
            val column = value?.let { ", poll_interval_minutes" } ?: ""
            val literal = value?.let { ", $it" } ?: ""
            return "INSERT INTO jira_connections " +
                "(name, site_url, email, api_token, auth_scheme, project_keys, created_at, updated_at$column) " +
                "VALUES ('$name', 'https://sample.atlassian.net', 'a@b.c', '$token', 'BASIC', " +
                "'[\"SP\"]'::jsonb, 1, 1$literal)"
        }
        val defaulted = unique("schema-default")
        assertNull(sqlState(withInterval(null, defaulted)), "the column may be left out")
        assertEquals(15, int("SELECT poll_interval_minutes FROM jira_connections WHERE name = '$defaulted'"))
        for (ok in listOf("5", "1440", "NULL")) assertNull(sqlState(withInterval(ok)), "interval $ok")
        for (bad in listOf("4", "1441", "0", "-5")) assertEquals(CHECK, sqlState(withInterval(bad)), "interval $bad")
        val id = newConnection()
        val stored = int("SELECT poll_interval_minutes FROM jira_connections WHERE id = $id")
        assertEquals(15, stored, "the DEFAULT backfills a row that names no interval")
        assertEquals(CHECK, sqlState("UPDATE jira_connections SET poll_interval_minutes = 4 WHERE id = $id"))
        assertNull(sqlState("UPDATE jira_connections SET poll_interval_minutes = NULL WHERE id = $id"), "NULL = manual only")
    }

    @Test
    fun `an acknowledgement is a 64-hex fingerprint with its time, and an acknowledger needs both`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val owner = TestPeople.seed(unique("owner"))
        val program = TestPlan.program(TestPlan.workStream(owner), owner)
        val c = newConnection()
        val binding = PostgresTestSupport.connect().use { conn ->
            conn.createStatement().use { st ->
                st.executeQuery(
                    "INSERT INTO jira_bindings (connection_id, level, program_id, jira_issue_id, jira_issue_key, created_at, updated_at) " +
                        "VALUES ($c, 'PROGRAM', $program, '88', 'SP-88', 1, 1) RETURNING id",
                ).use { rs -> rs.next(); rs.getInt(1) }
            }
        }
        val hex = "ab".repeat(32)
        fun ack(set: String) = sqlState("UPDATE jira_bindings SET $set WHERE id = $binding")

        assertEquals(CHECK, ack("ack_fingerprint = '${hex.dropLast(1)}', ack_at = 5"), "a 63-character fingerprint")
        assertEquals(TOO_LONG, ack("ack_fingerprint = '${hex}0', ack_at = 5"), "a 65-character fingerprint overflows the column")
        assertEquals(CHECK, ack("ack_fingerprint = '${hex.uppercase()}', ack_at = 5"), "lower-case hex only")
        assertEquals(CHECK, ack("ack_fingerprint = '${"g".repeat(64)}', ack_at = 5"), "hex only")
        assertEquals(CHECK, ack("ack_fingerprint = NULL, ack_at = 5"), "ack_at without a fingerprint")
        assertEquals(CHECK, ack("ack_fingerprint = '$hex', ack_at = NULL"), "a fingerprint without ack_at")
        assertNull(ack("ack_fingerprint = '$hex', ack_at = 5"), "a login-less acknowledgement is valid (the user was deleted or never set)")
        assertEquals(FOREIGN_KEY, ack("ack_by_user_id = 999999999"), "ack_by_user_id references users")
        val user = TestUsers.seed(uniqueEmail("schema"), "schema-pass-1")
        assertNull(ack("ack_fingerprint = NULL, ack_at = NULL, ack_by_user_id = NULL"), "an un-acknowledge clears all three columns")
        assertEquals(CHECK, ack("ack_by_user_id = $user"), "an acknowledger needs an acknowledgement (ack_at is NULL here)")
        assertNull(ack("ack_fingerprint = '$hex', ack_at = 5, ack_by_user_id = $user"), "the full acknowledgement")
        assertEquals(CHECK, ack("ack_fingerprint = NULL, ack_at = NULL"), "clearing only two of the three leaves a user without ack_at")
        assertNull(ack("ack_fingerprint = NULL, ack_at = NULL, ack_by_user_id = NULL"), "an un-acknowledge clears all three columns")
    }

    @Test
    fun `a deviation acknowledgement is one row per binding and kind, with a kind shape, a 64-hex fingerprint, both references`() =
        runBlocking {
            PostgresTestSupport.ensureMigrated()
            val owner = TestPeople.seed(unique("owner"))
            val program = TestPlan.program(TestPlan.workStream(owner), owner)
            val c = newConnection()
            val bindingId = PostgresTestSupport.connect().use { conn ->
                conn.createStatement().use { st ->
                    st.executeQuery(
                        "INSERT INTO jira_bindings " +
                            "(connection_id, level, program_id, jira_issue_id, jira_issue_key, created_at, updated_at) " +
                            "VALUES ($c, 'PROGRAM', $program, '89', 'SP-89', 1, 1) RETURNING id",
                    ).use { rs -> rs.next(); rs.getInt(1) }
                }
            }
            val user = TestUsers.seed(uniqueEmail("schema"), "schema-pass-1")
            val hex = "ab".repeat(32)
            fun ack(
                kind: String? = "END_MOVED",
                fingerprint: String? = hex,
                at: String = "5",
                by: Any = user,
                binding: Any = bindingId,
            ) = sqlState(
                "INSERT INTO jira_deviation_acknowledgements (binding_id, kind, fingerprint, ack_at, ack_by_user_id) VALUES " +
                    "($binding, ${kind?.let { "'$it'" }}, ${fingerprint?.let { "'$it'" }}, $at, $by)",
            )

            assertNull(ack())
            assertEquals(UNIQUE, ack(), "one acknowledgement per (binding, kind)")
            assertEquals(UNIQUE, ack(fingerprint = "cd".repeat(32)), "whatever the fingerprint")
            assertNull(ack(kind = "GONE"), "another kind of the same binding")
            assertNull(ack(kind = "A"), "a one-letter kind")
            assertNull(ack(kind = "A" + "B".repeat(31)), "the longest kind: 32 characters")
            assertEquals(CHECK, ack(kind = "lower"), "upper-case letters and underscores only")
            assertEquals(CHECK, ack(kind = "_LEAD"), "starts with a letter")
            assertEquals(CHECK, ack(kind = "END MOVED"), "no spaces")
            assertEquals(CHECK, ack(kind = "END1"), "no digits")
            assertEquals(CHECK, ack(kind = ""), "not empty")
            assertEquals(TOO_LONG, ack(kind = "A" + "B".repeat(32)), "a 33-character kind overflows the column")
            assertEquals(CHECK, ack(kind = "OTHER", fingerprint = hex.dropLast(1)), "63 characters")
            assertEquals(TOO_LONG, ack(kind = "OTHER", fingerprint = hex + "0"), "65 characters overflow the column")
            assertEquals(CHECK, ack(kind = "OTHER", fingerprint = hex.uppercase()), "lower-case hex only")
            assertEquals(CHECK, ack(kind = "OTHER", fingerprint = "g".repeat(64)), "hex only")
            assertEquals(FOREIGN_KEY, ack(kind = "OTHER", binding = 999999999), "an acknowledgement needs its binding")
            assertEquals(FOREIGN_KEY, ack(kind = "OTHER", by = 999999999), "and its acknowledger")
            assertEquals(NOT_NULL, ack(kind = null), "kind is required")
            assertEquals(NOT_NULL, ack(kind = "OTHER", fingerprint = null), "fingerprint is required")
            assertEquals(NOT_NULL, ack(kind = "OTHER", at = "NULL"), "ack_at is required")
            assertEquals(NOT_NULL, ack(kind = "OTHER", by = "NULL"), "ack_by_user_id is required")
            assertEquals(NOT_NULL, ack(kind = "OTHER", binding = "NULL"), "binding_id is required")
            val rows = int("SELECT count(*) FROM jira_deviation_acknowledgements WHERE binding_id = $bindingId")
            assertEquals(4, rows, "only the valid rows landed")
        }

    @Test
    fun `the database refuses a plaintext token, and a NULL one unless the connection is deleted`() {
        PostgresTestSupport.ensureMigrated()
        fun withToken(value: String?, deleted: Boolean = false): String {
            val literal = value?.let { "'$it'" } ?: "NULL"
            return "INSERT INTO jira_connections " +
                "(name, site_url, email, api_token, auth_scheme, project_keys, created_at, updated_at, marked_as_deleted) " +
                "VALUES ('${unique("schema")}', 'https://sample.atlassian.net', 'a@b.c', $literal, 'BASIC', " +
                "'[\"SP\"]'::jsonb, 1, 1, $deleted)"
        }
        assertEquals(CHECK, sqlState(withToken("plain-token")), "plaintext at rest is refused")
        assertEquals(CHECK, sqlState(withToken("")), "an empty value is not an envelope")
        assertEquals(CHECK, sqlState(withToken("ENC:V1:abc")), "the prefix is exact")
        assertEquals(CHECK, sqlState(withToken("plain-token", deleted = true)), "a deleted row may not hold plaintext either")
        assertEquals(CHECK, sqlState(withToken(null)), "an ACTIVE connection always has a token")
        assertNull(sqlState(withToken(null, deleted = true)), "a deleted connection holds NULL: the destroyed credential")
        assertNull(sqlState(withToken(FieldCipher(DEV_DATA_ENCRYPTION_KEY).encrypt("x"))))
        val id = newConnection()
        assertEquals(CHECK, sqlState("UPDATE jira_connections SET api_token = 'plain-token' WHERE id = $id"), "no downgrade by update")
        assertEquals(CHECK, sqlState("UPDATE jira_connections SET api_token = NULL WHERE id = $id"), "nor NULLing an active row")
        assertNull(sqlState("UPDATE jira_connections SET api_token = NULL, marked_as_deleted = TRUE WHERE id = $id"), "a delete does")
        val revive = sqlState("UPDATE jira_connections SET marked_as_deleted = FALSE WHERE id = $id")
        assertEquals(CHECK, revive, "and a NULL cannot be revived")
    }

    @Test
    fun `a run's requester is a real user`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val c = newConnection()
        fun run(requester: String) =
            sqlState(
                "INSERT INTO sync_runs (kind, connection_id, \"trigger\", requested_by_user_id, started_at, finished_at, outcome) " +
                    "VALUES ('JIRA', $c, 'MANUAL', $requester, 1, 2, 'SUCCEEDED')",
            )
        assertEquals(FOREIGN_KEY, run("999999999"), "requested_by_user_id references users")
        assertNull(run("NULL"), "a scheduled or anonymous run has no requester")
        val user = TestUsers.seed(uniqueEmail("schema"), "schema-pass-1")
        assertNull(run(user.toString()))
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

        // V27: the probe stamp is a nullable BIGINT that only a gone row may carry.
        assertEquals(
            1,
            int(
                "SELECT count(*) FROM information_schema.columns WHERE table_name = 'jira_observations' " +
                    "AND column_name = 'gone_probed_at' AND data_type = 'bigint' AND is_nullable = 'YES'",
            ),
            "gone_probed_at is a nullable BIGINT",
        )
        val update = "UPDATE jira_observations SET"
        assertEquals(CHECK, sqlState("$update gone_probed_at = 5 WHERE binding_id = $binding"), "not gone: no stamp")
        assertNull(sqlState("$update gone = TRUE, gone_reason = 'OUT_OF_SCOPE', gone_probed_at = 5 WHERE binding_id = $binding"))
        assertEquals(CHECK, sqlState("$update gone = FALSE WHERE binding_id = $binding"), "clearing gone must clear the stamp")
        assertNull(sqlState("$update gone = FALSE, gone_reason = NULL, gone_probed_at = NULL WHERE binding_id = $binding"))
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

    @Test
    fun `a census row is one issue per connection with a closed status vocabulary, and census_at is nullable`() {
        PostgresTestSupport.ensureMigrated()
        val c = newConnection()
        fun issue(id: String = "5", connection: Int = c, status: String = "TODO", level: String = "0") = sqlState(
            "INSERT INTO jira_issues (connection_id, issue_id, issue_key, hierarchy_level, status_category, observed_at) " +
                "VALUES ($connection, '$id', 'SP-5', $level, '$status', 1)",
        )

        assertNull(issue())
        assertEquals(UNIQUE, issue(), "one mirror row per (connection, issue)")
        assertNull(issue(connection = newConnection()), "another connection mirrors the same issue id")
        assertEquals(FOREIGN_KEY, issue(connection = 999999999), "the connection must exist")
        assertEquals(CHECK, issue(id = "6", status = "WAITING"), "the status vocabulary is closed")
        assertEquals(CHECK, issue(id = "abc"), "the issue id is digits")
        assertEquals(TOO_LONG, issue(id = "1".repeat(21)), "a 21-digit id never fits the column")
        val tooLong = "INSERT INTO jira_issues (connection_id, issue_id, issue_key, hierarchy_level, status_category, summary, " +
            "observed_at) VALUES ($c, '7', 'SP-7', 0, 'DONE', '${"x".repeat(256)}', 1)"
        assertEquals(TOO_LONG, sqlState(tooLong), "the summary column is 255 wide: the store fits it first")
        for ((column, width) in listOf("issue_key" to 50, "type_id" to 20, "parent_issue_id" to 20)) {
            val wide = "INSERT INTO jira_issues (connection_id, issue_id, issue_key, hierarchy_level, status_category, observed_at" +
                (if (column == "issue_key") "" else ", $column") + ") VALUES ($c, '8', " +
                (if (column == "issue_key") "'${"K".repeat(width + 1)}'" else "'SP-8'") + ", 0, 'DONE', 1" +
                (if (column == "issue_key") "" else ", '${"1".repeat(width + 1)}'") + ")"
            assertEquals(TOO_LONG, sqlState(wide), "$column is $width wide")
        }
        assertEquals(1, int("SELECT count(*) FROM pg_indexes WHERE indexname = 'ix_jira_issues_parent'"), "the parent index exists")
        assertEquals(0, int("SELECT count(census_at) FROM jira_connections WHERE id = $c"), "census_at is NULL on a new row")
        assertNull(sqlState("UPDATE jira_connections SET census_at = 5 WHERE id = $c"))
        assertNull(sqlState("UPDATE jira_connections SET census_at = NULL WHERE id = $c"), "and nullable again")
    }
}
