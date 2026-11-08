package ch.nokillswit.flow

import ch.nokillswit.teams.CapacityImportCreate
import ch.nokillswit.teams.CapacityImportUpdate
import ch.nokillswit.teams.CapacityImportWrites
import ch.nokillswit.teams.CapacitySource
import java.math.BigDecimal
import java.math.RoundingMode

/** The writes the apply makes and the rows it leaves alone. */
data class CapacityApplyDecision(val writes: CapacityImportWrites, val skipped: List<CapacityApplySkipped>)

/**
 * The apply's decision (pure): the requested rows against [CapacityPlan], the plan the kernel computed UNDER the team lock from the
 * mirror and the periods as they are now. **Nothing the request says is trusted beyond what the plan confirms.**
 *
 * An item is imported only when the plan lists its sprint as a `CREATE` or an `UPDATE` and its `action`, `effectiveFrom` and `mdPerWeek`
 * equal the row's `expected` - so a sprint whose start date a person has since taken over (`MANUAL_PERIOD`), a figure that moved, a
 * sprint that left Flow or was re-dated, and a row the request invented are all skipped `CHANGED`. The period an `UPDATE` rewrites is the
 * plan's `existing` period (never an id from the request), and only a FLOW one. A removal is applied only when its period is one of the
 * plan's `removals` now (a FLOW period); a MANUAL period, a deleted one and an unknown id are not, so they are skipped `CHANGED`.
 */
object CapacityApplyKernels {
    fun decide(plan: CapacityPlan, command: CapacityApplyCommand): CapacityApplyDecision {
        val bySprint = plan.items.associateBy { it.sprintId }
        val creates = mutableListOf<CapacityImportCreate>()
        val updates = mutableListOf<CapacityImportUpdate>()
        val skipped = mutableListOf<CapacityApplySkipped>()
        for (row in command.items) {
            val item = bySprint[row.sprintId]?.takeIf { matches(it, row) }
            val figure = item?.mdPerWeek?.let(::figureOf)
            val existing = item?.existing
            when {
                item == null || figure == null -> skipped += changed(sprintId = row.sprintId)
                item.action == CapacityAction.CREATE && existing == null ->
                    creates += CapacityImportCreate(row.effectiveFrom, figure, item.sprintId, item.name)
                item.action == CapacityAction.UPDATE && existing != null && existing.source == CapacitySource.FLOW ->
                    updates += CapacityImportUpdate(existing.periodId, figure, item.sprintId, item.name)
                else -> skipped += changed(sprintId = row.sprintId)
            }
        }
        val removable = plan.removals.mapTo(HashSet()) { it.periodId }
        val (deletes, kept) = command.removals.partition { it in removable }
        kept.forEach { skipped += changed(periodId = it) }
        return CapacityApplyDecision(CapacityImportWrites(creates, updates, deletes), skipped)
    }

    private fun matches(item: CapacityImportItem, row: CapacityApplyRow): Boolean =
        item.action == row.action && item.effectiveFrom == row.effectiveFrom.toString() &&
            item.mdPerWeek?.let { figureOf(it).compareTo(row.mdPerWeek.setScale(MD_SCALE, RoundingMode.HALF_UP)) == 0 } == true

    /**
     * The kernel's figure as the plan carries it on the wire (a two-decimal `Double` below 1,000,000: the round trip through
     * [BigDecimal.valueOf] is exact); rounding is explicit (`HALF_UP`), so a figure can never make this throw.
     */
    private fun figureOf(wire: Double): BigDecimal = BigDecimal.valueOf(wire).setScale(MD_SCALE, RoundingMode.HALF_UP)

    private fun changed(sprintId: Long? = null, periodId: UInt? = null) =
        CapacityApplySkipped(sprintId, periodId, CapacityApplySkipReason.CHANGED)

    private const val MD_SCALE = 2
}
