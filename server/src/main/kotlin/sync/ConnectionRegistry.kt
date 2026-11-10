package ch.nokillswit.sync

import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

/**
 * The columns every connector's connection table shares and the scheduler, the status and the run guards read (`jira_connections`,
 * `flow_connections`). It deliberately has NO token column: `sync/` never sees the credential column, so nothing here can select,
 * decrypt or log it (`security.md` "Encryption at rest"); each connector's service alone owns that column and its decrypting readers.
 */
interface ConnectionColumns : SoftDeletable {
    val name: Column<String>
    val enabled: Column<Boolean>

    /** Minutes between scheduled runs; null = manual only. */
    val pollIntervalMinutes: Column<Int?>
    val updatedAt: Column<Long>
}

/** What a run in flight may still do with its connection ([runnableStateOf]). */
enum class RunnableState { RUNNABLE, GONE, DISABLED }

/**
 * Whether the connection is still there to run against, for a run in flight: [RunnableState.GONE] once it is deleted (its token is
 * destroyed, so a copy held in memory must not authenticate one more read), [RunnableState.DISABLED] once an administrator switched it
 * off. Its own short transaction; no token is read.
 */
suspend fun <T> runnableStateOf(database: R2dbcDatabase, table: T, id: UInt): RunnableState
    where T : UIntIdTable, T : ConnectionColumns = suspendTransaction(database) {
    val enabled = table.select(table.enabled).where { (table.id eq id) and table.active() }.toList().singleOrNull()?.get(table.enabled)
    when (enabled) {
        null -> RunnableState.GONE
        false -> RunnableState.DISABLED
        true -> RunnableState.RUNNABLE
    }
}

/** Whether the connection is active and enabled: what a manual run needs before it claims. */
suspend fun <T> isRunnable(database: R2dbcDatabase, table: T, id: UInt): Boolean
    where T : UIntIdTable, T : ConnectionColumns = runnableStateOf(database, table, id) == RunnableState.RUNNABLE

/**
 * Whether the connection is ACTIVE (not deleted), locking its row `FOR SHARE` for the rest of the CALLER's open transaction (it opens
 * none): the claim's guard ([SyncRunService.claim]). The lock conflicts with the connection delete's `FOR NO KEY UPDATE`, so a claim and
 * a delete of one connection serialize: the delete committed first and this answers false (nothing is inserted), or the claim holds the
 * lock until its INSERT commits and the delete, which waited, then removes the new row with the rest of the connection's runs. Without
 * it a claim whose connector check passed just before the delete would commit an unfinished row for a connection that no longer
 * exists, which nothing prunes (`sync_runs` has no foreign key). A disabled connection is still locked and answered true: the run
 * itself ends `CONNECTION_DISABLED`.
 */
suspend fun <T> lockActiveConnection(table: T, id: UInt): Boolean
    where T : UIntIdTable, T : ConnectionColumns =
    table.select(table.id).where { (table.id eq id) and table.active() }
        .forUpdate(ForUpdateOption.PostgreSQL.ForShare).toList().isNotEmpty()

/**
 * The scheduler's rows of one connector's connections: every ACTIVE connection, in id order, in one budgeted transaction
 * ([queryTimeoutSeconds], 0 = none). It selects the shared [ConnectionColumns] (never a credential) plus the connector's own [extra]
 * columns that [toRow] needs for `ready` and `changedAt` (those two rules differ per connector and stay with it).
 */
suspend fun <T> pollRowsOf(
    database: R2dbcDatabase,
    table: T,
    extra: List<Column<*>>,
    queryTimeoutSeconds: Int,
    toRow: (ResultRow) -> ConnectorConnection,
): List<ConnectorConnection> where T : UIntIdTable, T : ConnectionColumns = suspendTransaction(database) {
    queryTimeout = queryTimeoutSeconds
    table.select(listOf(table.id, table.name, table.enabled, table.pollIntervalMinutes, table.updatedAt) + extra)
        .where { table.active() }.orderBy(table.id).toList().map(toRow)
}
