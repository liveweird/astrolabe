package ch.nokillswit.flow

import ch.nokillswit.infra.time.WorkingCalendar
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

// The capacity import's dating and claims (split out of `CapacityImportKernels`, whose KDoc is their rulebook): when a sprint holds days
// (Flow's `end ?: complete ?: start`), which of them it may claim, and the long windows' leftover runs. Pure, like the kernel.

/**
 * Flow's `capacity_source` values whose total is a FIXED per-sprint figure that claims do not reduce: the team's default, and the legacy
 * `CONFIGURED` ("the old CONFIGURED semantics", `metrics.md`). Such a sprint spreads over the working days of its OWN window.
 */
private val FIXED_FIGURE_SOURCES = setOf("TEAM_DEFAULT", "CONFIGURED")

/** A sprint with its first and last day in the zone (null = no usable span) and whether it ended before the window. */
internal class Dated(val sprint: FlowMirrorSprint, val start: LocalDate?, val end: LocalDate?, val closed: Boolean) {
    /** Whether the sprint has a usable span (a start and an end on or after it): only such a sprint is planned. */
    val hasSpan: Boolean get() = start != null && end != null && end >= start

    /**
     * The last day the sprint holds (Flow's claim span is `end ?: complete ?: start`): its end, or its start day when it has a start
     * but no usable end (none, or one before the start - the row stays NO_DATES); null without a start.
     */
    val holdsUntil: LocalDate? get() = if (hasSpan) end else start

    /** Whether the span is longer than Flow's calendar cap ([FLOW_MAX_CALENDAR_DAYS]): the sprint claims after all others. */
    val longWindow: Boolean
        get() = hasSpan && ChronoUnit.DAYS.between(checkNotNull(start), checkNotNull(end)) + 1 > FLOW_MAX_CALENDAR_DAYS
}

/**
 * What the sprint may claim: [effectiveFrom] is the first day its figure holds (its start, or the day after the last day an earlier
 * sprint holds; for a long window the first day no other sprint holds), [workingDays] the working days from there to its end (for a
 * long window, those of the days left); [skip] is the first rule that refuses it.
 * [figureDays] is the divisor of the weekly figure: [workingDays], except for a `TEAM_DEFAULT`/`CONFIGURED` sprint (a fixed figure in
 * Flow, not reduced by claims), which spreads over the working days of its OWN window `[start, end]`.
 */
internal class Claim(
    val effectiveFrom: LocalDate?,
    val workingDays: Long?,
    val skip: CapacitySkipReason?,
    val figureDays: Long? = workingDays,
)

internal fun datedOf(sprint: FlowMirrorSprint, zone: ZoneId, window: LocalDate): Dated {
    fun dateOf(instant: Long): LocalDate = Instant.ofEpochMilli(instant).atZone(zone).toLocalDate()
    val startAt = sprint.startAt
    val spanEnd = spanEndOf(sprint)
    // An end before the start is shown as sent and stays NO_DATES; else Flow's `max(start, end - 1 ms)` (zero-length = one day).
    val end = when {
        startAt == null || spanEnd == null -> null
        spanEnd < startAt -> dateOf(spanEnd)
        else -> dateOf(maxOf(startAt, spanEnd - 1))
    }
    return Dated(sprint, startAt?.let(::dateOf), end, closed = end != null && end < window)
}

internal fun claimOf(row: Dated, claimedEnd: LocalDate?, calendar: WorkingCalendar): Claim {
    val start = row.start
    val end = row.end
    if (!row.hasSpan || start == null || end == null) return Claim(null, null, CapacitySkipReason.NO_DATES)
    val effectiveFrom = if (claimedEnd == null) start else maxOf(start, claimedEnd.plusDays(1))
    if (effectiveFrom > end) return claimFrom(row, null, null, calendar)
    return claimFrom(row, effectiveFrom, calendar.workingDaysBetween(effectiveFrom, end), calendar)
}

/**
 * The claims of the long-window rows (Flow 1.57.1: an over-cap sprint claims LAST), by row. Each takes the days of its `[start, end]`
 * that no sprint within the cap holds and no earlier long window (start, then id) took; those days are the gaps between the held
 * intervals, so a window of any length costs one pass over the intervals plus one calendar lookup per gap.
 */
internal fun longClaims(dated: List<Dated>, calendar: WorkingCalendar): Map<Dated, Claim> {
    val held = dated.filter { !it.longWindow }.mapNotNull { row -> row.start?.let { it to checkNotNull(row.holdsUntil) } }
        .sortedBy { it.first }.toMutableList()
    return dated.filter { it.longWindow }.associateWith { row ->
        val start = checkNotNull(row.start)
        val end = checkNotNull(row.end)
        val gaps = gapsOf(held, start, end)
        held.add(start to end)
        held.sortBy { it.first }
        val days = gaps.takeIf { it.isNotEmpty() }?.sumOf { (from, to) -> calendar.workingDaysBetween(from, to) }
        claimFrom(row, gaps.firstOrNull()?.first, days, calendar)
    }
}

/** The maximal runs of `[start, end]` that no interval of [held] (sorted by start) covers, in date order. */
private fun gapsOf(held: List<Pair<LocalDate, LocalDate>>, start: LocalDate, end: LocalDate): List<Pair<LocalDate, LocalDate>> {
    val gaps = mutableListOf<Pair<LocalDate, LocalDate>>()
    var cursor = start
    for ((from, to) in held) {
        if (from > end) break
        if (to < cursor) continue
        if (from > cursor) gaps.add(cursor to from.minusDays(1))
        cursor = maxOf(cursor, to.plusDays(1))
    }
    if (cursor <= end) gaps.add(cursor to end)
    return gaps
}

/** The claim of a row with a usable span: [effectiveFrom] and [days] null = no day left (OVERLAPS), else the working days it holds. */
private fun claimFrom(row: Dated, effectiveFrom: LocalDate?, days: Long?, calendar: WorkingCalendar): Claim {
    val skip = when {
        row.sprint.capacityMd == null -> CapacitySkipReason.NO_CAPACITY
        effectiveFrom == null -> CapacitySkipReason.OVERLAPS
        days == 0L -> CapacitySkipReason.NO_WORKING_DAY
        else -> null
    }
    // TEAM_DEFAULT is fixed per sprint in Flow, not reduced by what earlier sprints hold: its OWN window is the divisor.
    val figureDays = if (row.sprint.capacitySource in FIXED_FIGURE_SOURCES) {
        calendar.workingDaysBetween(checkNotNull(row.start), checkNotNull(row.end))
    } else {
        days
    }
    return Claim(effectiveFrom, days, skip, figureDays)
}
