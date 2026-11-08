package ch.nokillswit.flow

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.teams.CapacitySource

private const val NO_LIMIT = "none"

/**
 * The audit trail of one capacity apply, emitted AFTER the commit: the per-period events (`team.capacity_period_created/updated/deleted`,
 * the capacity routes' own fields, plus the provenance - `sourceTo=FLOW` on a created or updated period, `sourceFrom=FLOW` on every
 * update and delete) and ONE `team.capacity_imported` summary (ids comma-joined; written even when every row was skipped: the attempt is
 * what the trail records). The WIP limit of an update is unchanged (the import keeps it), so its `wipLimitFrom/To` are equal.
 */
internal fun auditCapacityImport(caller: CallerPrincipal, outcome: CapacityImportOutcome) {
    val byUserId = caller.userId.toLong()
    val teamId = outcome.teamId.toLong()
    val applied = outcome.applied
    val flow = CapacitySource.FLOW.name
    applied.created.forEach {
        audit(
            "team.capacity_period_created",
            "byUserId" to byUserId, "teamId" to teamId, "periodId" to it.periodId.toLong(),
            "effectiveFrom" to it.effectiveFrom.toString(), "mdPerWeek" to it.mdPerWeek.toDouble(), "wipLimit" to NO_LIMIT,
            "sourceTo" to flow,
        )
    }
    applied.updated.forEach {
        audit(
            "team.capacity_period_updated",
            "byUserId" to byUserId, "teamId" to teamId, "periodId" to it.periodId.toLong(),
            "effectiveFromFrom" to it.before.effectiveFrom.toString(), "effectiveFromTo" to it.before.effectiveFrom.toString(),
            "mdPerWeekFrom" to it.before.mdPerWeek.toDouble(), "mdPerWeekTo" to it.mdPerWeek.toDouble(),
            "wipLimitFrom" to (it.before.wipLimit ?: NO_LIMIT), "wipLimitTo" to (it.before.wipLimit ?: NO_LIMIT),
            "sourceFrom" to flow, "sourceTo" to flow,
            "flowSprintIdFrom" to (it.flowSprintIdBefore ?: NO_LIMIT), "flowSprintIdTo" to it.flowSprintId,
            "flowSprintNameFrom" to (it.flowSprintNameBefore ?: NO_LIMIT), "flowSprintNameTo" to it.flowSprintName,
        )
    }
    applied.deleted.forEach {
        audit(
            "team.capacity_period_deleted",
            "byUserId" to byUserId, "teamId" to teamId, "periodId" to it.toLong(), "sourceFrom" to flow,
        )
    }
    audit(
        "team.capacity_imported",
        "byUserId" to byUserId,
        "teamId" to teamId,
        "bindingId" to outcome.bindingId.toLong(),
        "connectionId" to outcome.connectionId.toLong(),
        "createdIds" to applied.created.map { it.periodId }.sorted().joinToString(","),
        "updatedIds" to applied.updated.map { it.periodId }.sorted().joinToString(","),
        "deletedIds" to applied.deleted.sorted().joinToString(","),
        "skippedCount" to applied.extra.size,
    )
}
