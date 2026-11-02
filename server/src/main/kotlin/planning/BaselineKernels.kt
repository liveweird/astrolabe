package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import java.math.BigDecimal

/*
 * The baseline comparison as pure functions (no I/O, no clock), the idiom of `CriticalPathKernels.kt` and Covenant's baseline-versus-
 * live `Finding`s (`contracts/checks/BreakingChanges.kt`): a FROZEN fact beside a LIVE fact gives a [Movement], and "no baseline row"
 * (ADDED) and "no live row" (REMOVED) are first-class answers, not errors. Deltas are WORKING days on the CURRENT calendar
 * (`planning-model.md` "Baselines"; the user's answer Q6a): positive = later, start and end reported separately.
 */

/** A milestone as the baseline froze it ([span] null = it was unscheduled then). */
data class FrozenMilestone(
    val id: UInt,
    val projectId: UInt,
    val teamId: UInt,
    val name: String,
    val estimateMd: BigDecimal,
    val span: DaySpan?,
)

/** A milestone as the plan holds it now ([span] null = unscheduled). */
data class LiveMilestone(
    val id: UInt,
    val projectId: UInt,
    val teamId: UInt,
    val name: String,
    val estimateMd: BigDecimal,
    val span: DaySpan?,
)

/**
 * What happened to one row since the baseline. [UNCHANGED] and [MOVED] need a dated row on both sides ([UNCHANGED]: both effective
 * deltas are zero, or neither side is dated); [SCHEDULED]/[UNSCHEDULED] are a dated/undated flip; [ADDED]/[REMOVED] a row on one
 * side only.
 */
enum class MovementKind { UNCHANGED, MOVED, SCHEDULED, UNSCHEDULED, ADDED, REMOVED }

/**
 * One row's movement. [startDays]/[endDays] are the signed working-day deltas (positive = later) and are non-null only for a row
 * dated on both sides; [estimateDelta] (`live - frozen`) is non-null whenever the row exists on both sides, whatever the [kind]
 * (an estimate change alone leaves the kind [MovementKind.UNCHANGED]).
 */
data class Movement(val kind: MovementKind, val startDays: Int?, val endDays: Int?, val estimateDelta: BigDecimal?)

/**
 * The counts over a list of movements. [later]/[earlier] are the [moved] rows whose END is later/earlier (a start-only move is
 * [moved] but neither).
 */
data class MovementTotals(
    val unchanged: Int,
    val moved: Int,
    val later: Int,
    val earlier: Int,
    val scheduled: Int,
    val unscheduled: Int,
    val added: Int,
    val removed: Int,
)

object BaselineKernels {
    /**
     * The movement of one milestone: [frozen] null = [MovementKind.ADDED], [live] null = [MovementKind.REMOVED] (both null is a
     * caller bug). With both present: the span rules of [spanMovement], plus the estimate delta.
     */
    fun milestoneMovement(frozen: FrozenMilestone?, live: LiveMilestone?, calendar: WorkingCalendar): Movement {
        require(frozen != null || live != null) { "a movement needs a frozen or a live row" }
        if (frozen == null) return Movement(MovementKind.ADDED, null, null, null)
        if (live == null) return Movement(MovementKind.REMOVED, null, null, null)
        return spanMovement(frozen.span, live.span, calendar).copy(estimateDelta = live.estimateMd - frozen.estimateMd)
    }

    /**
     * The movement of a span (a project's, a program's, a work stream's): null/dated flips are [MovementKind.SCHEDULED] and
     * [MovementKind.UNSCHEDULED], two null spans are [MovementKind.UNCHANGED]. Two dated spans give
     * `startDays = W(live effective start) - W(frozen effective start)` and `endDays` likewise on the effective ends; both zero is
     * [MovementKind.UNCHANGED] (a Saturday-dated start moved to its Monday is not movement), else [MovementKind.MOVED].
     */
    fun spanMovement(frozen: DaySpan?, live: DaySpan?, calendar: WorkingCalendar): Movement = when {
        frozen == null && live == null -> Movement(MovementKind.UNCHANGED, null, null, null)
        frozen == null -> Movement(MovementKind.SCHEDULED, null, null, null)
        live == null -> Movement(MovementKind.UNSCHEDULED, null, null, null)
        else -> {
            val startDays = shiftInWorkingDays(frozen, live, calendar)
            val endDays = endShiftInWorkingDays(frozen, live, calendar)
            val kind = if (startDays == 0 && endDays == 0) MovementKind.UNCHANGED else MovementKind.MOVED
            Movement(kind, startDays, endDays, null)
        }
    }

    /** The counts over [movements]; [MovementTotals.later]/[MovementTotals.earlier] read the [MovementKind.MOVED] rows' end. */
    fun totals(movements: Iterable<Movement>): MovementTotals {
        val counts = IntArray(MovementKind.entries.size)
        var later = 0
        var earlier = 0
        for (movement in movements) {
            counts[movement.kind.ordinal]++
            if (movement.kind != MovementKind.MOVED) continue
            val endDays = movement.endDays ?: continue
            if (endDays > 0) later++ else if (endDays < 0) earlier++
        }
        fun count(kind: MovementKind) = counts[kind.ordinal]
        return MovementTotals(
            unchanged = count(MovementKind.UNCHANGED),
            moved = count(MovementKind.MOVED),
            later = later,
            earlier = earlier,
            scheduled = count(MovementKind.SCHEDULED),
            unscheduled = count(MovementKind.UNSCHEDULED),
            added = count(MovementKind.ADDED),
            removed = count(MovementKind.REMOVED),
        )
    }
}
