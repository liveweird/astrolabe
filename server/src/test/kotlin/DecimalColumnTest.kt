package ch.nokillswit

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.core.dao.id.IntIdTable
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.greaterEq
import org.jetbrains.exposed.v1.r2dbc.insert
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.r2dbc.update
import java.math.BigDecimal
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The spike for the milestone estimate column (V14 `milestones.estimate_md NUMERIC(8,2)`): Exposed's `decimal(name, 8, 2)` must
 * round-trip a
 * [BigDecimal] through exposed-r2dbc against a real PostgreSQL exactly — insert, select, update, a WHERE parameter, the stored text over
 * raw
 * JDBC equal to the sent text, and numeric ordering and comparison. None of exposed-r2dbc 1.6.0's type mappers names `BigDecimal`, so the
 * binding rides the default mapper; this test is the proof that it is enough. A scratch table by raw DDL, never `SchemaUtils.create`.
 * If this goes red the fallback is a repo-local column type in `infra/db/` binding the value through its plain-text literal (the
 * `JavaLocalDateColumnType` shape) with the same wire format.
 */
class DecimalColumnTest {

    private object Scratch : IntIdTable("decimal_column_test") {
        val md = decimal("md", 8, 2)
    }

    private val samples = listOf("0.00", "0.10", "12.25", "999999.99", "1.00", "0.01")

    private suspend fun freshScratchTable() {
        suspendTransaction(sharedDatabaseForTests()) {
            exec("CREATE TABLE IF NOT EXISTS decimal_column_test (id SERIAL PRIMARY KEY, md NUMERIC(8,2))")
            exec("TRUNCATE TABLE decimal_column_test")
        }
    }

    private suspend fun readMd(id: Int): BigDecimal = suspendTransaction(sharedDatabaseForTests()) {
        Scratch.selectAll().where { Scratch.id eq id }.toList().single()[Scratch.md]
    }

    /** The stored value as the server renders it, bypassing every driver conversion. */
    private fun storedText(id: Int): String = PostgresTestSupport.connect().use { conn ->
        conn.createStatement().use { st ->
            st.executeQuery("SELECT md::text FROM decimal_column_test WHERE id = $id").use { rs ->
                rs.next()
                rs.getString(1)
            }
        }
    }

    @Test
    fun `a stored estimate reads back equal and the stored text is the sent text`() = runBlocking<Unit> {
        freshScratchTable()
        val db = sharedDatabaseForTests()
        for (text in samples) {
            val sent = BigDecimal(text)
            val id = suspendTransaction(db) { Scratch.insert { it[md] = sent }[Scratch.id].value }
            assertEquals(0, sent.compareTo(readMd(id)), "$text must survive the round trip")
            assertEquals(text, storedText(id), "the stored text of $text")
        }
    }

    @Test
    fun `a value sent without its trailing zeros is stored at scale two`() = runBlocking<Unit> {
        freshScratchTable()
        val db = sharedDatabaseForTests()
        for ((sent, stored) in listOf("0" to "0.00", "0.1" to "0.10", "12.5" to "12.50", "3" to "3.00")) {
            val id = suspendTransaction(db) { Scratch.insert { it[md] = BigDecimal(sent) }[Scratch.id].value }
            assertEquals(stored, storedText(id), "stored text of $sent")
            assertEquals(2, readMd(id).scale(), "a read value carries the column scale")
        }
    }

    @Test
    fun `update and a WHERE parameter match the exact decimal`() = runBlocking<Unit> {
        freshScratchTable()
        val db = sharedDatabaseForTests()
        val id = suspendTransaction(db) { Scratch.insert { it[md] = BigDecimal("1.00") }[Scratch.id].value }
        suspendTransaction(db) { Scratch.update({ Scratch.id eq id }) { it[md] = BigDecimal("12.25") } }
        assertEquals("12.25", storedText(id))
        val hits = suspendTransaction(db) { Scratch.selectAll().where { Scratch.md eq BigDecimal("12.25") }.toList().size }
        assertEquals(1, hits)
        val misses = suspendTransaction(db) { Scratch.selectAll().where { Scratch.md eq BigDecimal("12.26") }.toList().size }
        assertEquals(0, misses)
    }

    @Test
    fun `greaterEq and orderBy follow numeric order, not text order`() = runBlocking<Unit> {
        freshScratchTable()
        val db = sharedDatabaseForTests()
        val sent = listOf("9.00", "10.00", "0.50", "100.25", "2.75")
        suspendTransaction(db) { for (text in sent) Scratch.insert { it[md] = BigDecimal(text) } }
        val ascending = suspendTransaction(db) {
            Scratch.selectAll().orderBy(Scratch.md, SortOrder.ASC).toList().map { it[Scratch.md].toPlainString() }
        }
        assertEquals(listOf("0.50", "2.75", "9.00", "10.00", "100.25"), ascending)
        val atLeastTen = suspendTransaction(db) {
            Scratch.selectAll().where { Scratch.md greaterEq BigDecimal("10.00") }.orderBy(Scratch.md).toList()
                .map { it[Scratch.md].toPlainString() }
        }
        assertEquals(listOf("10.00", "100.25"), atLeastTen)
    }
}
