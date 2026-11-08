package ch.nokillswit.teams

import java.math.BigDecimal
import java.time.LocalDate

/**
 * The capacity import's writes, as `flow/` decided them under the team row lock ([TeamCapacityService.applyImport]). `teams/` does not
 * name `flow/`: these are plain capacity-period writes with the Flow provenance on them. **Only FLOW periods are ever updated or removed**
 * - the service re-checks that against the rows it read under the lock and in the `WHERE` of every statement, whatever [CapacityImportWrites]
 * says.
 */
data class CapacityImportWrites(
    val creates: List<CapacityImportCreate>,
    val updates: List<CapacityImportUpdate>,
    /** FLOW periods to soft-delete. */
    val deletes: List<UInt>,
)

/** A new `FLOW` period for [flowSprintId] starting on [effectiveFrom] (no WIP limit: Flow has none). */
data class CapacityImportCreate(
    val effectiveFrom: LocalDate,
    val mdPerWeek: BigDecimal,
    val flowSprintId: Long,
    val flowSprintName: String,
)

/**
 * A `FLOW` period [periodId] re-pointed at [flowSprintId]: sets `md_per_week`, `flow_sprint_id`, `flow_sprint_name` and `updated_at`;
 * its date and its WIP limit are KEPT.
 */
data class CapacityImportUpdate(val periodId: UInt, val mdPerWeek: BigDecimal, val flowSprintId: Long, val flowSprintName: String)

/** A period the import wrote: its new id and what it holds (the per-period audit's input). */
data class CapacityImportCreated(val periodId: UInt, val effectiveFrom: LocalDate, val mdPerWeek: BigDecimal, val flowSprintId: Long)

/**
 * A period the import updated: the STORED values before (and the sprint it pointed at, null when it had none), the figure and the sprint
 * after - an update that only re-points or renames a period is visible in the audit through the sprint fields.
 */
data class CapacityImportUpdated(
    val periodId: UInt,
    val before: CapacityPeriodValues,
    val flowSprintIdBefore: Long?,
    val flowSprintNameBefore: String?,
    val mdPerWeek: BigDecimal,
    val flowSprintId: Long,
    val flowSprintName: String,
)

/**
 * What [TeamCapacityService.applyImport] wrote, in the order the writes were given; [extra] is whatever the caller's decision carried out
 * (the skips, in `flow/`'s own vocabulary).
 */
data class CapacityImportApplied<S>(
    val created: List<CapacityImportCreated>,
    val updated: List<CapacityImportUpdated>,
    val deleted: List<UInt>,
    val extra: S,
)
