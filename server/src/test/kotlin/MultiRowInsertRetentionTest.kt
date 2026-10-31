package ch.nokillswit

import ch.nokillswit.infra.db.insertRows
import kotlinx.coroutines.runBlocking
import org.jetbrains.exposed.v1.r2dbc.R2dbcTransaction
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * `insertRows` must not let a long transaction's memory grow with the rows it has written (`.claude/docs/build-times.md`
 * WHY 14). Exposed R2DBC 1.5.0's `R2dbcTransaction` keeps every statement it executed in
 * `executedStatements` until the transaction ends (`closeStatementsAndConnection`, at commit or rollback, only clears the list — it closes
 * nothing; `executeIn` itself clears it before a statement when `!supportsMultipleResultSets`). Each
 * multi-row statement (up to 32,000 bind parameters) drags its driver `PostgresqlStatement` with it: ~100,000 parsed SQL
 * tokens plus every encoded parameter, ~8 MB, so a long bulk-writing transaction (Flow's 24,000-issue DERIVE kept 700+ MB reachable)
 * dies at `-Xmx512m`. `writeRows` therefore calls `clearExecutedStatements()` after each chunk; the pin is the cause itself — the list
 * stays empty.
 */
class MultiRowInsertRetentionTest {
    private val table = MultiRowScratch

    // Exposed keeps the list internal; a rename on an upgrade fails here, loudly, and the pin must be re-derived then.
    private fun executedStatements(tx: R2dbcTransaction): Int {
        val field = R2dbcTransaction::class.java.getDeclaredField("executedStatements").also { it.isAccessible = true }
        return (field.get(tx) as List<*>).size
    }

    private suspend fun R2dbcTransaction.writeChunk(round: Int, rows: Int) {
        table.insertRows((1..rows).map { it + round * 10_000 }) {
            this[table.owner] = OWNER
            this[table.id] = it.toLong()
            this[table.name] = "row-$it"
            this[table.note] = null
        }
    }

    @Test
    fun `a transaction does not keep the statements insertRows executed`() = runBlocking {
        table.ensureCreated()
        try {
            suspendTransaction(sharedDatabaseForTests()) {
                repeat(3) { writeChunk(it, rows = 50) }
                assertEquals(0, executedStatements(this), "insertRows left its executed statements reachable until commit")
            }
        } finally {
            table.clear(OWNER)
        }
    }

    private companion object {
        const val OWNER = 903
    }
}
