package ch.nokillswit

import ch.nokillswit.teams.TeamColour
import org.flywaydb.core.Flyway
import java.sql.Connection
import java.sql.SQLException
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * V35's data rewrite (`teams.colour`, the backfill by `ROW_NUMBER() OVER (ORDER BY marked_as_deleted, id)`) on a database that holds
 * V34-era teams: the shared container migrates an EMPTY database, so this builds a scratch one (the `PersonMigrationTest` pattern),
 * migrates it to V34, seeds sixteen teams with soft-deleted ones mixed in, applies the rest and reads the colours back.
 */
class TeamColourMigrationTest {
    private fun flyway(database: String, target: String?): Flyway = Flyway.configure()
        .dataSource(PostgresTestSupport.jdbcUrlFor(database), PostgresTestSupport.user, PostgresTestSupport.password)
        .locations("classpath:db/migration")
        .apply { if (target != null) target(target) }
        .load()

    private fun Connection.insertTeam(name: String, deleted: Boolean): Int =
        prepareStatement(
            "INSERT INTO teams (\"name\", created_at, updated_at, marked_as_deleted) VALUES (?, 1, 1, ?) RETURNING id",
        ).use { st ->
            st.setString(1, name)
            st.setBoolean(2, deleted)
            st.executeQuery().use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }

    private fun Connection.colours(): Map<Int, String> = createStatement().use { st ->
        st.executeQuery("SELECT id, colour FROM teams ORDER BY id").use { rs ->
            buildMap { while (rs.next()) put(rs.getInt(1), rs.getString(2)) }
        }
    }

    @Test
    fun `V35 backfills the active teams first in id order, then the deleted ones, wrapping after twelve`() {
        val database = "v35_colour_${UUID.randomUUID().toString().replace("-", "").take(12)}"
        PostgresTestSupport.connect().use { it.createStatement().execute("CREATE DATABASE $database") }
        try {
            flyway(database, target = "34").migrate()
            // Sixteen teams by id; the 2nd, 5th, 9th and 12th are soft-deleted, so exactly twelve are active.
            val deletedPositions = setOf(2, 5, 9, 12)
            val ids = PostgresTestSupport.connect(database).use { c ->
                (1..16).map { c.insertTeam("Team $it", deleted = it in deletedPositions) }
            }
            val active = ids.filterIndexed { i, _ -> (i + 1) !in deletedPositions }
            val deleted = ids.filterIndexed { i, _ -> (i + 1) in deletedPositions }

            flyway(database, target = null).migrate()

            PostgresTestSupport.connect(database).use { c ->
                val palette = TeamColour.entries.map { it.name }
                val stored = c.colours()
                assertEquals(palette, active.map { stored.getValue(it) }, "the active teams get the whole palette once, in id order")
                assertEquals(palette.take(4), deleted.map { stored.getValue(it) }, "the deleted ones follow and wrap to the start")

                // The DEFAULT stays: a team inserted by a build that does not know the column reads INDIGO.
                val late = c.insertTeam("Late", deleted = false)
                assertEquals("INDIGO", c.colours().getValue(late))

                // The CHECK refuses a key outside the palette; NOT NULL refuses an unset colour.
                val outside = assertFailsWith<SQLException> {
                    c.createStatement().execute("UPDATE teams SET colour = 'MAUVE' WHERE id = $late")
                }
                assertEquals("23514", outside.sqlState, "ck_teams_colour")
                val unset = assertFailsWith<SQLException> {
                    c.createStatement().execute("UPDATE teams SET colour = NULL WHERE id = $late")
                }
                assertEquals("23502", unset.sqlState, "NOT NULL")
            }
        } finally {
            PostgresTestSupport.connect().use { it.createStatement().execute("DROP DATABASE IF EXISTS $database WITH (FORCE)") }
        }
    }
}
