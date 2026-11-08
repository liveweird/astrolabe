package ch.nokillswit.planning

import ch.nokillswit.infra.db.maxRowsPerStatement
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.db.payloadChunkSizes
import org.jetbrains.exposed.v1.core.EntityIDColumnType
import org.jetbrains.exposed.v1.core.IColumnType
import org.jetbrains.exposed.v1.r2dbc.transactions.TransactionManager

/** The bind parameters one row of the VALUES list carries: the milestone id and the two dates. */
private const val PARAMETERS_PER_ROW = 3

/**
 * Writes [items]' dates (a null span unschedules) and stamps `schedule_revision = [newRevision]` and `updated_at`, as
 * `UPDATE milestones SET … FROM (VALUES (id, start, end), …) AS v(id, s, e) WHERE milestones.id = v.id`: a multi-row statement instead
 * of one round trip per item while the batch holds the plan lock. The VALUES columns are cast explicitly (`::int`, `::date`) so a
 * null pair binds. **The pin rule (V25) lives in the same statement:** `pinned = pinned AND v.s IS NOT NULL` - a null span (the unschedule
 * pair) clears the pin, a dated one keeps it (`ck_milestones_pinned_scheduled` would refuse a pinned row without dates, so this clause is
 * what keeps every unscheduling writer from failing). The caller has already decided which items are written (they name ACTIVE
 * milestones of the right team under the lock), so there is no `active()` predicate here. Runs inside the caller's plan-locked transaction.
 *
 * Statements follow the `MultiRowInsert.kt` plan ([payloadChunkSizes] over payload-free rows): at most the bind cap's rows, otherwise a
 * power of two, so the SQL texts stay a handful instead of one per batch size (the prepared-statement cache is bounded,
 * `PREPARED_STATEMENT_CACHE_QUERIES`). A batch of up to 1000 items is at most six statements; one when it is a power of two.
 */
internal suspend fun writeSchedules(items: List<ValidatedBatchItem>, newRevision: Long) {
    if (items.isEmpty()) return
    val milestones = MilestoneService.Milestones
    val tx = TransactionManager.current()
    val idType = (milestones.id.columnType as EntityIDColumnType<*>).idColumn.columnType
    val dateType = milestones.startDate.columnType
    val stamp = nowMillis()
    val header = "UPDATE ${tx.identity(milestones)} SET ${tx.identity(milestones.startDate)} = v.s, " +
        "${tx.identity(milestones.endDate)} = v.e, ${tx.identity(milestones.pinned)} = " +
        "${tx.identity(milestones.pinned)} AND v.s IS NOT NULL, ${tx.identity(milestones.scheduleRevision)} = ?::bigint, " +
        "${tx.identity(milestones.updatedAt)} = ?::bigint FROM (VALUES "
    val footer = ") AS v(id, s, e) WHERE ${tx.identity(milestones)}.${tx.identity(milestones.id)} = v.id"
    val row = "(?::int, ?::date, ?::date)"
    val sizes = payloadChunkSizes(List(items.size) { 0 }, maxRowsPerStatement(PARAMETERS_PER_ROW), Long.MAX_VALUE)
    var offset = 0
    for (size in sizes) {
        val chunk = items.subList(offset, offset + size)
        offset += size
        val arguments = ArrayList<Pair<IColumnType<*>, Any?>>(2 + size * PARAMETERS_PER_ROW)
        arguments += milestones.scheduleRevision.columnType to newRevision
        arguments += milestones.updatedAt.columnType to stamp
        for (item in chunk) {
            arguments += idType to item.milestoneId
            arguments += dateType to item.span?.start
            arguments += dateType to item.span?.end
        }
        tx.exec(header + List(size) { row }.joinToString(", ") + footer, arguments)
    }
}
