package ch.nokillswit

import ch.nokillswit.infra.db.localDate
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.core.dao.id.IntIdTable
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.greaterEq
import org.jetbrains.exposed.v1.r2dbc.insert
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.r2dbc.update
import java.time.LocalDate
import java.util.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlin.test.assertNull

/**
 * The spike for the repo-local `DATE` column binding (`infra/db/LocalDateColumn.kt`, `persistence.md`
 * "The DATE column idiom"): it must round-trip a `java.time.LocalDate` through Exposed R2DBC against a
 * real PostgreSQL without a zone shift (the DST-change days and the epoch are where a `java.sql.Date`
 * detour would show), sort and compare in date order, round-trip null, and let a `CHECK` violation
 * surface as an exception (the constraint style the migrations use). A scratch table by raw DDL, never
 * `SchemaUtils.create`. If this goes red the fallback is the `VARCHAR(10)` ISO idiom (see the plan).
 */
class LocalDateColumnTest {

    private object Scratch : IntIdTable("local_date_column_test") {
        val day = localDate("day").nullable()
        val other = localDate("other").nullable()
    }

    private val sampleDays = listOf(
        LocalDate.of(1970, 1, 1), // the epoch
        LocalDate.of(2026, 3, 29), // DST starts (Europe)
        LocalDate.of(2026, 10, 25), // DST ends (Europe)
        LocalDate.of(2099, 12, 31),
    )

    // Days a java.sql.Date / default-zone detour gets wrong: before the Gregorian cutover, a zone's old offset
    // changes (Kiritimati skipped 1994-12-31, Apia skipped 2011-12-30), and a Julian-only date.
    private val trickyDays = listOf(
        LocalDate.of(1500, 1, 1),
        LocalDate.of(100, 2, 27),
        LocalDate.of(1994, 12, 31),
        LocalDate.of(2011, 12, 30),
        LocalDate.of(1899, 12, 31),
    )

    private val zones = listOf("UTC", "Pacific/Kiritimati", "Pacific/Apia", "Pacific/Pago_Pago", "Europe/Warsaw", "America/Sao_Paulo")

    private suspend fun freshScratchTable() {
        suspendTransaction(sharedDatabaseForTests()) {
            exec(
                "CREATE TABLE IF NOT EXISTS local_date_column_test (id SERIAL PRIMARY KEY, day DATE, other DATE, " +
                    "CONSTRAINT ck_local_date_column_test_order CHECK (other IS NULL OR day IS NULL OR other >= day))",
            )
            exec("TRUNCATE TABLE local_date_column_test")
        }
    }

    private suspend fun readDay(id: Int): LocalDate? = suspendTransaction(sharedDatabaseForTests()) {
        Scratch.selectAll().where { Scratch.id eq id }.toList().single()[Scratch.day]
    }

    /** The stored value as the server renders it, bypassing every driver conversion. */
    private fun storedText(id: Int): String? = PostgresTestSupport.connect().use { conn ->
        conn.createStatement().use { st ->
            st.executeQuery("SELECT day::text FROM local_date_column_test WHERE id = $id").use { rs ->
                rs.next()
                rs.getString(1)
            }
        }
    }

    /** Runs [block] once per swapped JVM default zone, restoring the original in a finally. */
    private suspend fun inEveryZone(block: suspend (zone: String) -> Unit) {
        val original = TimeZone.getDefault()
        try {
            for (zone in zones) {
                TimeZone.setDefault(TimeZone.getTimeZone(zone))
                block(zone)
            }
        } finally {
            TimeZone.setDefault(original)
        }
    }

    @Test
    fun `a stored date reads back equal for the epoch and both DST change days`() = runBlocking<Unit> {
        freshScratchTable()
        val db = sharedDatabaseForTests()
        for (day in sampleDays) {
            val id = suspendTransaction(db) { Scratch.insert { it[Scratch.day] = day }[Scratch.id].value }
            assertEquals(day, readDay(id), "$day must survive the round trip")
            assertEquals(day.toString(), storedText(id))
        }
    }

    @Test
    fun `insert, update and a WHERE parameter store and match the calendar date in every JVM default zone`() =
        runBlocking<Unit> {
            freshScratchTable()
            val db = sharedDatabaseForTests()
            inEveryZone { zone ->
                for (day in sampleDays + trickyDays) {
                    val id = suspendTransaction(db) { Scratch.insert { it[Scratch.day] = day }[Scratch.id].value }
                    assertEquals(day.toString(), storedText(id), "insert $day in $zone")
                    assertEquals(day, readDay(id), "read $day in $zone")

                    val other = LocalDate.of(2050, 6, 15)
                    suspendTransaction(db) { Scratch.update({ Scratch.id eq id }) { it[Scratch.day] = other } }
                    assertEquals("2050-06-15", storedText(id), "update to $other in $zone")
                    suspendTransaction(db) { Scratch.update({ Scratch.id eq id }) { it[Scratch.day] = day } }
                    assertEquals(day.toString(), storedText(id), "update back to $day in $zone")

                    // A WHERE parameter takes the same path as a written value.
                    val matched = suspendTransaction(db) {
                        Scratch.select(Scratch.id).where { Scratch.id eq id and (Scratch.day eq day) }.toList().size
                    }
                    assertEquals(1, matched, "WHERE day = $day in $zone")
                }
            }
        }

    @Test
    fun `update replaces a stored date and a null round-trips as null`() = runBlocking<Unit> {
        freshScratchTable()
        val db = sharedDatabaseForTests()
        val id = suspendTransaction(db) { Scratch.insert { it[Scratch.day] = LocalDate.of(2026, 1, 1) }[Scratch.id].value }
        suspendTransaction(db) { Scratch.update({ Scratch.id eq id }) { it[Scratch.day] = LocalDate.of(2026, 10, 25) } }
        assertEquals(LocalDate.of(2026, 10, 25), readDay(id))
        suspendTransaction(db) { Scratch.update({ Scratch.id eq id }) { it[Scratch.day] = null } }
        assertNull(readDay(id))
        val nullId = suspendTransaction(db) { Scratch.insert { it[Scratch.day] = null }[Scratch.id].value }
        assertNull(readDay(nullId))
    }

    @Test
    fun `comparison and ordering follow date order`() = runBlocking<Unit> {
        freshScratchTable()
        val db = sharedDatabaseForTests()
        // Inserted out of order on purpose.
        for (day in listOf(sampleDays[2], sampleDays[3], sampleDays[0], sampleDays[1])) {
            suspendTransaction(db) { Scratch.insert { it[Scratch.day] = day }[Scratch.id].value }
        }
        val ascending = suspendTransaction(db) {
            Scratch.select(Scratch.day).orderBy(Scratch.day to SortOrder.ASC).toList().map { it[Scratch.day] }
        }
        assertEquals(sampleDays, ascending)
        val atOrAfter = suspendTransaction(db) {
            Scratch.select(Scratch.day)
                .where { Scratch.day greaterEq LocalDate.of(2026, 3, 29) }
                .orderBy(Scratch.day to SortOrder.ASC)
                .toList()
                .map { it[Scratch.day] }
        }
        assertEquals(sampleDays.drop(1), atOrAfter)
    }

    @Test
    fun `a CHECK violation on two date columns surfaces as an exception`() = runBlocking<Unit> {
        freshScratchTable()
        val db = sharedDatabaseForTests()
        // other >= day holds: accepted (equal dates included).
        suspendTransaction(db) {
            Scratch.insert {
                it[Scratch.day] = LocalDate.of(2026, 3, 29)
                it[Scratch.other] = LocalDate.of(2026, 3, 29)
            }
        }
        val failure = assertFailsWith<Exception> {
            suspendTransaction(db) {
                Scratch.insert {
                    it[Scratch.day] = LocalDate.of(2026, 3, 29)
                    it[Scratch.other] = LocalDate.of(2026, 3, 28)
                }
            }
        }
        // SQLSTATE 23514 = check_violation, found anywhere in the cause chain (the R2DBC wrap varies).
        val states = generateSequence<Throwable>(failure) { it.cause }
            .mapNotNull { (it as? io.r2dbc.spi.R2dbcException)?.sqlState }
            .toList()
        assertTrue("23514" in states, "expected check_violation 23514, got $states from $failure")
    }
}
