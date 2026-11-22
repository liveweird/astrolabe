package ch.nokillswit.flow

import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*

/**
 * Deletes [binding]'s stored rows that are no longer [listed] while the caller holds its row lock. A present team's own
 * `TEAM_GONE` row is always judgeable; sprint rows are judged only when [sprintsJudgeable], and then only for ids in [inMirror].
 * A sprint missing from the mirror remains the run's decision because only it knows whether the document was truncated.
 */
internal suspend fun pruneUnlistedCapacityAcks(
    binding: FlowTeamBindingRow,
    listed: List<CapacityDeviation>,
    inMirror: Set<Long>,
    sprintsJudgeable: Boolean = true,
): List<Long?> {
    val keep = listedKeys(listed) ?: return emptyList()
    val table = CapacityAcknowledgeService.Acknowledgements
    val gone = table.select(table.id, table.sprintId).where { table.bindingId eq binding.id }.toList().filter {
        val sprint = it[table.sprintId]
        sprint == null || (sprintsJudgeable && sprint in inMirror && sprint !in keep)
    }
    if (gone.isEmpty()) return emptyList()
    table.deleteWhere { table.id inList gone.map { it[table.id] } }
    return gone.map { it[table.sprintId] }.sortedWith(compareBy(nullsFirst()) { it })
}

private fun listedKeys(listed: List<CapacityDeviation>): Set<Long?>? =
    listed.takeIf { rows -> rows.none { it.kind == CapacityDeviationKind.TEAM_GONE } }?.mapTo(HashSet()) { it.detail.sprintId }

internal fun BindingCapacityFacts?.mirroredSprintIds(): Set<Long> =
    this?.mirror?.sprints.orEmpty().mapTo(HashSet()) { it.sprintId }
