package ch.nokillswit

import kotlinx.coroutines.runBlocking
import java.sql.SQLException
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The V24 tables at the database (raw JDBC, no service): every CHECK, the partial unique indexes, the primary and foreign keys and the
 * `team_capacity_periods` provenance columns, by SQLSTATE. Rows are unique per test; the shared tables are never emptied.
 */
class FlowSchemaTest {
    private companion object {
        const val CHECK = "23514"
        const val UNIQUE = "23505"
        const val FOREIGN_KEY = "23503"
        const val NOT_NULL = "23502"
        const val TOO_LONG = "22001"
        const val PREFIX = "flow-schema"
    }

    private fun unique(prefix: String = PREFIX) = flowUnique(prefix)

    /** Runs [sql] on its own connection (autocommit); `null` on success, else the SQLSTATE. */
    private fun sqlState(sql: String): String? = PostgresTestSupport.connect().use { connection ->
        try {
            connection.createStatement().use { it.executeUpdate(sql) }
            null
        } catch (e: SQLException) {
            e.sqlState
        }
    }

    private fun scalar(sql: String): String? = jbScalar(sql) { it.getString(1) }

    private fun connectionSql(
        name: String = unique(),
        token: String? = "'${flowTestCipher.encrypt("x")}'",
        deleted: Boolean = false,
        interval: String? = null,
    ): String {
        val extraColumn = interval?.let { ", poll_interval_minutes" } ?: ""
        val extraValue = interval?.let { ", $it" } ?: ""
        return "INSERT INTO flow_connections " +
            "(name, base_url, time_zone, api_token, created_at, updated_at, marked_as_deleted$extraColumn) " +
            "VALUES ('$name', 'http://flow.test:8080', 'Europe/Warsaw', ${token ?: "NULL"}, 1, 1, $deleted$extraValue)"
    }

    private fun newConnection(): Int = jbScalar(connectionSql() + " RETURNING id") { it.getInt(1) }

    @AfterTest
    fun cleanUp() {
        removeFlowFixtureRows(PREFIX)
        jbSql("DELETE FROM team_capacity_periods WHERE team_id IN (SELECT id FROM teams WHERE name LIKE '$PREFIX%')")
        jbSql("DELETE FROM teams WHERE name LIKE '$PREFIX%'")
    }

    @Test
    fun `a connection's token is an envelope or NULL on a deleted row, and its interval is NULL or 5 to 1440`() {
        PostgresTestSupport.ensureMigrated()
        assertNull(sqlState(connectionSql()))
        assertEquals(CHECK, sqlState(connectionSql(token = "'plaintext'")), "a plaintext token is refused (the service encrypts first)")
        assertEquals(CHECK, sqlState(connectionSql(token = null)), "a live connection needs its token")
        assertNull(sqlState(connectionSql(token = null, deleted = true)), "a deleted connection's credential is destroyed (NULL)")
        for (ok in listOf("5", "60", "1440", "NULL")) assertNull(sqlState(connectionSql(interval = ok)), "interval $ok")
        for (bad in listOf("4", "1441", "0", "-5")) assertEquals(CHECK, sqlState(connectionSql(interval = bad)), "interval $bad")
        val withoutInterval = unique()
        assertNull(sqlState(connectionSql(name = withoutInterval)))
        assertNull(scalar("SELECT poll_interval_minutes FROM flow_connections WHERE name = '$withoutInterval'"), "no DEFAULT: manual only")
    }

    @Test
    fun `the active name is unique case-insensitively and a deleted connection frees it`() {
        PostgresTestSupport.ensureMigrated()
        val name = unique("flow-schema-dup")
        assertNull(sqlState(connectionSql(name = name)))
        assertEquals(UNIQUE, sqlState(connectionSql(name = name.uppercase())))
        assertNull(sqlState("UPDATE flow_connections SET marked_as_deleted = TRUE, api_token = NULL WHERE name = '$name'"))
        assertNull(sqlState(connectionSql(name = name)), "a deleted connection frees its name")
    }

    @Test
    fun `the mirror tables are keyed per connection and reference an existing connection`() {
        PostgresTestSupport.ensureMigrated()
        val c = newConnection()
        val team = "INSERT INTO flow_teams (connection_id, flow_team_id, name, observed_at) VALUES ($c, 7, 'T', 1)"
        assertNull(sqlState(team))
        assertEquals(UNIQUE, sqlState(team), "one row per (connection, Flow team)")
        assertEquals(FOREIGN_KEY, sqlState(team.replace("($c, 7", "(999999999, 7")), "a team needs its connection")

        val sprint = "INSERT INTO flow_sprints (connection_id, flow_team_id, sprint_id, source_connection_id, name, state, has_calendar) " +
            "VALUES ($c, 7, 70, 1, 'S', 'ACTIVE', TRUE)"
        assertNull(sqlState(sprint))
        assertEquals(UNIQUE, sqlState(sprint))
        assertNull(sqlState(sprint.replace("($c, 7, 70", "($c, 8, 70")), "the same sprint id may belong to another team")
        assertEquals(FOREIGN_KEY, sqlState(sprint.replace("($c, 7", "(999999999, 7")))
        assertEquals(NOT_NULL, sqlState(sprint.replace("TRUE)", "NULL)")), "has_calendar is NOT NULL")

        val member = "INSERT INTO flow_members (connection_id, flow_team_id, account_id, valid_from) VALUES ($c, 7, 'acc', 100)"
        assertNull(sqlState(member))
        assertEquals(UNIQUE, sqlState(member), "one row per (connection, team, account, valid_from)")
        assertNull(sqlState(member.replace("'acc', 100", "'acc', 200")), "a second interval of the same account")
        assertEquals(FOREIGN_KEY, sqlState(member.replace("($c, 7", "(999999999, 7")))
        assertEquals(TOO_LONG, sqlState(member.replace("'acc'", "'${"x".repeat(129)}'")), "account_id is at most 128 characters")
    }

    @Test
    fun `a team has one active Flow team across connections, a Flow team one team, and an unlink frees both`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val c1 = newConnection()
        val c2 = newConnection()
        val teamA = TestTeams.seed(unique())
        val teamB = TestTeams.seed(unique())
        val user = TestUsers.seed(uniqueEmail("flowschema"), "schema-pass-1")
        fun binding(connection: Int, team: UInt, flowTeam: Int, deleted: Boolean = false) =
            "INSERT INTO flow_team_bindings (connection_id, team_id, flow_team_id, flow_team_name, created_by_user_id, created_at, " +
                "updated_at, marked_as_deleted) VALUES ($connection, $team, $flowTeam, 'FT', $user, 1, 1, $deleted)"

        assertNull(sqlState(binding(c1, teamA, 5)))
        assertEquals(UNIQUE, sqlState(binding(c2, teamA, 6)), "a team binds once, even across connections")
        assertEquals(UNIQUE, sqlState(binding(c1, teamB, 5)), "a Flow team of a connection binds once")
        assertNull(sqlState(binding(c2, teamB, 5)), "the same Flow team id on ANOTHER connection is another Flow team")
        assertNull(sqlState(binding(c1, teamB, 9, deleted = true)), "a deleted binding holds nothing")
        val teamC = TestTeams.seed(unique()) // free of any binding, so only the foreign key can refuse the rows below
        assertEquals(FOREIGN_KEY, sqlState(binding(999999999, teamC, 9)), "a binding needs its connection")
        assertEquals(FOREIGN_KEY, sqlState(binding(c1, 999999999u, 9)), "a binding needs its team")
        assertEquals(FOREIGN_KEY, sqlState(binding(c1, teamC, 9).replace("$user, 1, 1", "999999999, 1, 1")), "a binding needs its user")
        assertNull(sqlState("UPDATE flow_team_bindings SET marked_as_deleted = TRUE WHERE connection_id = $c1 AND team_id = $teamA"))
        assertNull(sqlState(binding(c2, teamA, 6)), "unlinking frees the team")
        assertNull(sqlState(binding(c1, teamC, 5)), "and the Flow team")
    }

    @Test
    fun `a capacity period is MANUAL by default and its source is MANUAL or FLOW`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val team = TestTeams.seed(unique())
        fun period(date: String, columns: String = "", values: String = "") =
            "INSERT INTO team_capacity_periods (team_id, effective_from, md_per_week, created_at, updated_at$columns) " +
                "VALUES ($team, '$date', 10, 1, 1$values)"
        assertNull(sqlState(period("2047-01-05")))
        assertEquals("MANUAL", scalar("SELECT source FROM team_capacity_periods WHERE team_id = $team"), "a row without a source is MANUAL")
        assertNull(scalar("SELECT flow_sprint_id FROM team_capacity_periods WHERE team_id = $team"))
        assertNull(sqlState(period("2047-01-19", ", source, flow_sprint_id, flow_sprint_name", ", 'FLOW', 4711, 'Sprint 12'")))
        assertEquals(
            "Sprint 12",
            scalar("SELECT flow_sprint_name FROM team_capacity_periods WHERE team_id = $team AND source = 'FLOW'"),
        )
        assertEquals(CHECK, sqlState(period("2047-02-02", ", source", ", 'ROBOT'")), "the source is MANUAL or FLOW")
        assertEquals(CHECK, sqlState(period("2047-02-02", ", source", ", 'flow'")), "case matters")
        assertEquals(
            TOO_LONG,
            sqlState(period("2047-02-16", ", source, flow_sprint_id, flow_sprint_name", ", 'FLOW', 1, '${"s".repeat(256)}'")),
            "flow_sprint_name is at most 255 characters",
        )
    }

    @Test
    fun `a FLOW period names its sprint and a MANUAL one names none`() = runBlocking {
        PostgresTestSupport.ensureMigrated()
        val team = TestTeams.seed(unique())
        fun period(date: String, columns: String, values: String) =
            "INSERT INTO team_capacity_periods (team_id, effective_from, md_per_week, created_at, updated_at, $columns) " +
                "VALUES ($team, '$date', 10, 1, 1, $values)"
        assertEquals(CHECK, sqlState(period("2047-03-02", "source", "'FLOW'")), "FLOW without a sprint")
        assertEquals(CHECK, sqlState(period("2047-03-02", "source, flow_sprint_id", "'FLOW', 5")), "FLOW without the sprint name")
        assertEquals(CHECK, sqlState(period("2047-03-02", "source, flow_sprint_name", "'FLOW', 'S'")), "FLOW without the sprint id")
        assertEquals(CHECK, sqlState(period("2047-03-02", "flow_sprint_id", "5")), "MANUAL with a sprint id")
        assertEquals(CHECK, sqlState(period("2047-03-02", "flow_sprint_name", "'S'")), "MANUAL with a sprint name")
        assertNull(sqlState(period("2047-03-02", "source, flow_sprint_id, flow_sprint_name", "'FLOW', 5, 'S'")))
        // The takeover: one UPDATE turns it MANUAL and clears both columns; clearing only one is refused.
        assertEquals(CHECK, sqlState("UPDATE team_capacity_periods SET source = 'MANUAL' WHERE team_id = $team"), "sprint left behind")
        assertEquals(CHECK, sqlState("UPDATE team_capacity_periods SET flow_sprint_id = NULL WHERE team_id = $team"), "half cleared")
        val takeover = "UPDATE team_capacity_periods SET source = 'MANUAL', flow_sprint_id = NULL, flow_sprint_name = NULL " +
            "WHERE team_id = $team"
        assertNull(sqlState(takeover))
    }
}
