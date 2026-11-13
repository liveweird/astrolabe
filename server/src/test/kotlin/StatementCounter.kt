package ch.nokillswit

import org.jetbrains.exposed.v1.core.statements.StatementContext
import org.jetbrains.exposed.v1.r2dbc.R2dbcTransaction
import org.jetbrains.exposed.v1.r2dbc.statements.SuspendStatementInterceptor

/**
 * Records every statement one transaction sends (Flow's `InsertCounter` shape: a per-transaction `SuspendStatementInterceptor`;
 * register it with `registerInterceptor(counter)` as the first thing in a `suspendTransaction`). Shared by the statement-count pins
 * ([JiraFlagsScaleTest], [JiraLinksViewTest]): a query per row fails where a timing would not show it.
 */
class StatementCounter : SuspendStatementInterceptor {
    val sql = mutableListOf<String>()

    override suspend fun beforeExecution(transaction: R2dbcTransaction, context: StatementContext) {
        sql += context.sql(transaction)
    }
}
