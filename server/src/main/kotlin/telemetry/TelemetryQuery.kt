package ch.nokillswit.telemetry

import io.r2dbc.spi.Row
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.statements.StatementType
import org.jetbrains.exposed.v1.r2dbc.R2dbcTransaction

/** Runs a SELECT and maps each row; the rows are read whole (every use is a handful of catalog rows or one grouped aggregation). */
internal suspend fun <T : Any> R2dbcTransaction.query(sql: String, map: (Row) -> T): List<T> =
    exec(sql, explicitStatementType = StatementType.SELECT) { row -> map(row) }?.toList().orEmpty().filterNotNull()
