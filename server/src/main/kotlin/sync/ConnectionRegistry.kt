package ch.nokillswit.sync

import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
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
