package ch.nokillswit

import java.sql.Connection
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.flywaydb.core.Flyway

/**
 * V10's data rewrite (`teams.manager_user_id` -> `people` + `teams.manager_person_id`) on a database that holds V9-era
 * data. The suite's shared container migrates an EMPTY database, so this builds a scratch database of its own, migrates it
 * to V9, seeds users and teams, then applies V10 and reads the result back — the one check an empty-container run cannot make.
 */
class PersonMigrationTest {

    private fun flyway(database: String, target: String?): Flyway = Flyway.configure()
        .dataSource(PostgresTestSupport.jdbcUrlFor(database), PostgresTestSupport.user, PostgresTestSupport.password)
        .locations("classpath:db/migration")
        .apply { if (target != null) target(target) }
        .load()

    private fun Connection.insertUser(name: String, email: String, deleted: Boolean = false): Long =
        prepareStatement(
            "INSERT INTO users (\"name\", email, password_hash, marked_as_deleted) VALUES (?, ?, 'x', ?) RETURNING id",
        ).use { st ->
            st.setString(1, name)
            st.setString(2, email)
            st.setBoolean(3, deleted)
            st.executeQuery().use { rs ->
                rs.next()
                rs.getLong(1)
            }
        }

    private fun Connection.insertTeam(name: String, managerUserId: Long?, deleted: Boolean = false): Int =
        prepareStatement(
            "INSERT INTO teams (\"name\", created_at, updated_at, marked_as_deleted, manager_user_id) VALUES (?, 1, 1, ?, ?) RETURNING id",
        ).use { st ->
            st.setString(1, name)
            st.setBoolean(2, deleted)
            st.setObject(3, managerUserId)
            st.executeQuery().use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }

    @Test
    fun `V10 backfills one person per active manager of an active team and drops manager_user_id`() {
        val database = "v10_backfill_${UUID.randomUUID().toString().replace("-", "").take(12)}"
        PostgresTestSupport.connect().use { it.createStatement().execute("CREATE DATABASE $database") }
        try {
            flyway(database, target = "9").migrate()
            val ids = PostgresTestSupport.connect(database).use { c ->
                val ann = c.insertUser("Ann Manager", "ann@test")
                val bob = c.insertUser("Bob Retired Team", "bob@test")
                val cy = c.insertUser("Cy Deleted", "cy@test", deleted = true)
                c.insertUser("Dee Nothing", "dee@test")
                val eve = c.insertUser("Eve Mixed", "Eve@Test")
                // users.email is unique as typed, so two logins can differ only in case; both manage an active team.
                val fayA = c.insertUser("Fay Upper", "Fay@Test")
                val fayB = c.insertUser("Fay Lower", "fay@test")
                mapOf(
                    "ann" to ann,
                    "twoTeamsA" to c.insertTeam("Alpha", ann).toLong(),
                    "twoTeamsB" to c.insertTeam("Beta", ann).toLong(),
                    "retired" to c.insertTeam("Retired", bob, deleted = true).toLong(),
                    "deletedManager" to c.insertTeam("Orphaned", cy).toLong(),
                    "unmanaged" to c.insertTeam("Free", null).toLong(),
                    "eveLive" to c.insertTeam("Eve Live", eve).toLong(),
                    "eveDead" to c.insertTeam("Eve Dead", eve, deleted = true).toLong(),
                    "fayA" to c.insertTeam("Fay A", fayA).toLong(),
                    "fayB" to c.insertTeam("Fay B", fayB).toLong(),
                )
            }

            flyway(database, target = null).migrate()

            PostgresTestSupport.connect(database).use { c ->
                val people = c.createStatement().use { st ->
                    st.executeQuery("SELECT id, \"name\", email, user_id, marked_as_deleted FROM people ORDER BY id").use { rs ->
                        buildList {
                            while (rs.next()) {
                                add(listOf(rs.getInt(1), rs.getString(2), rs.getString(3), rs.getLong(4), rs.getBoolean(5)))
                            }
                        }
                    }
                }
                assertEquals(
                    listOf("Ann Manager", "Eve Mixed", "Fay Upper", "Fay Lower"),
                    people.map { it[1] },
                    "one person per active user who manages an active team (two teams: still one)",
                )
                val person = people.first()
                assertEquals("Ann Manager", person[1])
                assertEquals("ann@test", person[2], "the email is lower-cased")
                assertEquals(ids.getValue("ann"), person[3], "the login is linked")
                assertFalse(person[4] as Boolean)

                fun managerOf(teamId: Long): Int? = c.prepareStatement("SELECT manager_person_id FROM teams WHERE id = ?").use { st ->
                    st.setInt(1, teamId.toInt())
                    st.executeQuery().use { rs ->
                        rs.next()
                        rs.getInt(1).takeUnless { rs.wasNull() }
                    }
                }
                assertEquals(person[0], managerOf(ids.getValue("twoTeamsA")))
                assertEquals(person[0], managerOf(ids.getValue("twoTeamsB")))
                assertNull(managerOf(ids.getValue("retired")), "a deleted team's manager is not carried over")
                assertNull(managerOf(ids.getValue("deletedManager")), "a soft-deleted manager stays unset")
                assertNull(managerOf(ids.getValue("unmanaged")))

                // The mixed case: one user manages an active AND a deleted team - only the active one is backfilled.
                val eve = people[1]
                assertEquals("eve@test", eve[2])
                assertEquals(eve[0], managerOf(ids.getValue("eveLive")))
                assertNull(managerOf(ids.getValue("eveDead")), "a deleted team's manager_person_id stays NULL")

                // A case-only email duplicate does not abort the migration: the later user's person has no email.
                assertEquals("fay@test", people[2][2])
                assertNull(people[3][2], "people.email is unique case-insensitively")
                assertEquals(people[3][0], managerOf(ids.getValue("fayB")))

                val columns = c.metaData.getColumns(null, "public", "teams", null).use { rs ->
                    buildList { while (rs.next()) add(rs.getString("COLUMN_NAME")) }
                }
                assertTrue("manager_person_id" in columns)
                assertFalse("manager_user_id" in columns, "the old column is dropped")
            }
        } finally {
            PostgresTestSupport.connect().use { it.createStatement().execute("DROP DATABASE IF EXISTS $database WITH (FORCE)") }
        }
    }
}
