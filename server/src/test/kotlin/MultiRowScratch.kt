package ch.nokillswit

import org.jetbrains.exposed.v1.core.Table
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.r2dbc.deleteWhere
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

/**
 * A private scratch table for the `infra/db/MultiRowInsert.kt` tests: the writers are generic, and Astrolabe's foundation schema has no
 * wide, bulk-written table of its own, so the tests write into this one (created on first use, never part of a migration). Rows are
 * partitioned by [owner] so two writers (the Exposed reference and `insertRows`) can write the SAME rows side by side and be compared.
 */
internal object MultiRowScratch : Table("multi_row_scratch") {
    val owner = integer("owner")
    val id = long("id")
    val name = varchar("name", 50)
    val note = text("note").nullable()

    /** A client-side default: no row sets it, and the writers must still fill it like `batchInsert` does. */
    val flag = bool("flag").default(false)
    override val primaryKey = PrimaryKey(owner, id)

    /** Columns per row: the bind-parameter budget of a statement is `32,000 / 5` = 6,400 rows. */
    const val ROWS_PER_STATEMENT = 6_400

    private var created = false

    suspend fun ensureCreated() {
        if (created) return
        suspendTransaction(sharedDatabaseForTests()) {
            exec(
                "CREATE TABLE IF NOT EXISTS multi_row_scratch (owner INT NOT NULL, id BIGINT NOT NULL, name VARCHAR(50) NOT NULL, " +
                    "note TEXT, flag BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY (owner, id))",
            )
        }
        created = true
    }

    suspend fun clear(vararg owners: Int) = suspendTransaction(sharedDatabaseForTests()) {
        for (o in owners) deleteWhere { owner eq o }
    }
}
