package ch.nokillswit.flow

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.validateManDays
import ch.nokillswit.teams.CapacityPeriodRow
import ch.nokillswit.teams.CapacitySource
import io.ktor.server.plugins.BadRequestException
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

private const val WORKING_DAYS_PER_WEEK = 5L
private const val MD_SCALE = 2

/**
 * Flow's `capacity_source` values whose total is a FIXED per-sprint figure that claims do not reduce: the team's default, and the legacy
 * `CONFIGURED` ("the old CONFIGURED semantics", `metrics.md`). Such a sprint spreads over the working days of its OWN window.
 */
private val FIXED_FIGURE_SOURCES = setOf("TEAM_DEFAULT", "CONFIGURED")

/**
 * Flow's `MAX_CALENDAR_DAYS` (`metrics/CapacityKernels.kt`): a sprint spanning more calendar days gets no calendar there. A sprint over
 * it is listed `LONG_WINDOW` and unticked here. The second of the two knobs that follow Flow (the other is [spanEndOf]).
 */
internal const val FLOW_MAX_CALENDAR_DAYS = 60

/**
 * The instant a sprint's span ends at (before the `- 1 ms` that makes the last day), or null when the sprint has none. THE ONE PLACE the
 * span rule lives, because Flow may change it; each rule has a vector in `CapacityImportKernelsTest`:
 *
 * 1. **Flow today, used:** the PLANNED end first; a completion stands in only for a missing planned end (`resolveSprintWindow`,
 *    `metrics/CapacityKernels.kt`: `end ?: complete ?: start`). Astrolabe keeps `NO_DATES` for a sprint with a start and neither end,
 *    instead of Flow's one-day `?: start` fallback - a recorded, deliberate difference (the sprint still HOLDS its start day, as in
 *    Flow's `sprintSpan`: `end ?: complete ?: start`).
 * 2. The 1.5.0 rule `minOf(endAt, completeAt)` - WRONG against Flow (it shortened a sprint completed early and inflated its weekly
 *    figure: a 40 MD sprint planned to 09-15 and completed 09-14 read 9 working days / 22.22 where Flow counts 10 / 20.00).
 * 3. Flow's candidate (b), not adopted: `if (state == closed && completeAt < endAt) completeAt else (endAt ?: completeAt)`.
 */
internal fun spanEndOf(sprint: FlowMirrorSprint): Long? = sprint.endAt ?: sprint.completeAt

/** The kernel's answer: the listed sprints in start order (undated last) and the Flow periods it would remove. */
data class CapacityPlan(val items: List<CapacityImportItem>, val removals: List<CapacityImportRemoval>) {
    fun totals(): CapacityImportTotals {
        val counts = items.groupingBy { it.action }.eachCount()
        return CapacityImportTotals(
            create = counts[CapacityAction.CREATE] ?: 0,
            update = counts[CapacityAction.UPDATE] ?: 0,
            unchanged = counts[CapacityAction.UNCHANGED] ?: 0,
            skip = (counts[CapacityAction.SKIP] ?: 0) + (counts[CapacityAction.MANUAL_PERIOD] ?: 0),
            removals = removals.size,
        )
    }
}

/** A sprint with its first and last day in the zone (null = no usable span) and whether it ended before the window. */
private class Dated(val sprint: FlowMirrorSprint, val start: LocalDate?, val end: LocalDate?, val closed: Boolean) {
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
private class Claim(
    val effectiveFrom: LocalDate?,
    val workingDays: Long?,
    val skip: CapacitySkipReason?,
    val figureDays: Long? = workingDays,
)

/** A classified sprint: the wire item, plus what the removal rules read. */
private class Classified(val dated: Dated, val claim: Claim, val item: CapacityImportItem) {
    /** Whether the import covers the sprint's span with its figure (so a stale Flow period inside it must go). */
    val covers: Boolean get() = !dated.closed && !dated.longWindow && planned

    /** Whether the item is planned with a figure (CREATE, UPDATE or UNCHANGED). */
    private val planned: Boolean
        get() = item.action in setOf(CapacityAction.CREATE, CapacityAction.UPDATE, CapacityAction.UNCHANGED)
}

/** The weekly figure of a sprint; [inRange] says it passes the man-day bounds of a capacity period. */
private class Figure(val mdPerWeek: BigDecimal, val inRange: Boolean)

/**
 * The capacity import (pure: no clock, no database, no zone lookup): turns a Flow team's sprints into the man-days-per-week periods the
 * team would carry, against the team's ACTIVE periods. The rule, in the user's words: a sprint's man-days are spread over the sprint's
 * WORKING days (Astrolabe's calendar, holidays included), so the weekly capacity Astrolabe computes over the sprint adds up to what Flow
 * says (within rounding); one period per sprint; a period Flow wrote is Flow's to update and remove, a hand-entered one is NEVER changed.
 *
 * **The span** is Flow's (`DeriveSprintStep`, `resolveSprintWindow`; [spanEndOf] is its one home): the PLANNED end first, a completion
 * only for a missing planned end; `end = dayOf(max(startAt, spanEnd - 1 ms))` in [zone] (a zero-length sprint is one day; `spanEnd <
 * startAt` stays NO_DATES), so an end at local midnight adds no day. **The days a sprint holds are Flow's (`metrics.md` A42): the first
 * sprint holding a day claims it.** Every sprint with a start holds at least its start day, and one with a usable end (on or after the
 * start) holds `[start, end]`, whatever its capacity or skip reason (a start-only or inverted sprint stays NO_DATES but holds its start
 * day, as in Flow); a later sprint takes the days no earlier sprint holds, `effectiveFrom = max(start, claimedEnd + 1 day)`, where
 * `claimedEnd` is the latest day an earlier sprint holds. Sprints are walked in start order, so the days earlier sprints hold inside a
 * sprint's `[start, end]` are always a PREFIX of it and `[effectiveFrom, end]` IS the set of days no earlier sprint holds. Only a sprint
 * WHOLLY inside earlier ones (`effectiveFrom > end`) counts no day: `OVERLAPS`, and it advances nothing (its end is not past `claimedEnd`).
 * **A sprint over [FLOW_MAX_CALENDAR_DAYS] calendar days claims LAST** (Flow 1.57.1, PR #469; F11): it gets no calendar, is listed with the
 * info `LONG_WINDOW` and never ticked, and never advances `claimedEnd`, so every sprint within the cap is planned as if it were absent.
 * Its own claim is the days of `[start, end]` that no in-cap sprint holds and no earlier long-window sprint (start, then id) took
 * ([longClaims]): not necessarily a prefix, so they are computed as gaps between the held intervals; `effectiveFrom` is the first such
 * day and `workingDays` their working days. No leftover day is `OVERLAPS`, no leftover working day `NO_WORKING_DAY`. The figure is
 * partial: it spreads Flow's total over all the leftover runs, but the row is one period that holds only until the next starts.
 *
 * Per sprint, in start order (undated last, then by id), the first rule that fires: no start, no end, or an end before the start -
 * [CapacitySkipReason.NO_DATES]; no capacity - `NO_CAPACITY`; `effectiveFrom > end` - `OVERLAPS`; no working day from
 * `effectiveFrom` to `end` - `NO_WORKING_DAY`; then
 * `mdPerWeek = round2(5 x capacityMd / workingDays)` (HALF_UP), beyond the man-day bounds - `OUT_OF_RANGE`. The one exception is a sprint
 * whose `capacitySource` is `TEAM_DEFAULT` (or the legacy `CONFIGURED`): Flow's figure for it is fixed per sprint ("the team's default
 * figure, which needs a team but not a start", `DeriveSprintStep`), not reduced by claims, so it divides by the working days of the
 * sprint's OWN window `[start, end]` (the row then carries the info `FIXED_FIGURE` with that count when it exceeds the days it holds).
 * Otherwise against the ACTIVE period that starts on `effectiveFrom`: none - CREATE; a FLOW one - UPDATE when its figure, its sprint or
 * its name differ (the WIP limit
 * is kept: Flow has none), else UNCHANGED; a MANUAL one - MANUAL_PERIOD. Every MANUAL period starting inside `(effectiveFrom, end]` adds
 * the info `MANUAL_PERIOD_INSIDE(date)`. A sprint with 0 man-days is planned like any other but never ticked, with the info
 * `ZERO_CAPACITY` (Flow's DEFAULT figure is 0 for a team without members).
 *
 * A sprint whose `end` is before `from` (default [today]) is CLOSED: listed only with [includeClosed] and never ticked. A sprint is ticked
 * when it is not closed, not zero-capacity, not a long window and a CREATE or an UPDATE.
 *
 * `removals[]` are this team's FLOW periods that no listed sprint reuses and that (a) belong to a sprint missing from [sprints] and lie in
 * the import's window (`date >= from`, or any date with [includeClosed]: a sprint that aged out of Flow's document keeps its history),
 * (b) start inside `(effectiveFrom, end]` of a sprint the import covers (not closed, not a long window; CREATE, UPDATE or UNCHANGED), where
 * they would cut the sprint's figure short, or (c) belong to a LISTED sprint - closed or not, whatever its action or skip reason -
 * without being
 * the period its item reuses (a sprint moved later, e.g. a period imported under the 1.5.0 rule, or one that now holds no day). A refused
 * row (SKIP but for `OVERLAPS`) keeps the FLOW period at its own `effectiveFrom` (the last good figure; see [keptByRefusedRows]). A MANUAL
 * period is never offered.
 */
object CapacityImportKernels {
    @Suppress("LongParameterList") // the seven inputs of the plan's signature, named at the one call site
    fun plan(
        sprints: List<FlowMirrorSprint>,
        zone: ZoneId,
        calendar: WorkingCalendar,
        today: LocalDate,
        existingPeriods: List<CapacityPeriodRow>,
        from: LocalDate?,
        includeClosed: Boolean,
    ): CapacityPlan {
        val window = from ?: today
        val dated = sprints.sortedWith(compareBy<FlowMirrorSprint>({ it.startAt ?: Long.MAX_VALUE }, { it.sprintId }))
            .map { datedOf(it, zone, window) }
        val byDate = existingPeriods.associateBy { it.effectiveFrom }
        val manual = existingPeriods.filter { it.source == CapacitySource.MANUAL }
        var claimedEnd: LocalDate? = null
        // Pass 1: every sprint within the cap, in start order; a long window is planned as if absent and never advances claimedEnd.
        val inCap = dated.map { row ->
            if (row.longWindow) return@map null
            val claim = claimOf(row, claimedEnd, calendar)
            // Flow claims by window alone: advance for every sprint with a start, whatever its capacity or skip reason (a sprint wholly
            // inside an earlier one has an end not past claimedEnd, so it advances nothing by construction).
            row.holdsUntil?.let { held -> claimedEnd = maxOf(claimedEnd ?: held, held) }
            claim
        }
        // Pass 2: the long windows claim last, from what the others left.
        val longs = longClaims(dated, calendar)
        val classified = dated.zip(inCap) { row, claim ->
            val own = claim ?: longs.getValue(row)
            Classified(row, own, itemOf(row, own, own.effectiveFrom?.let(byDate::get), manual))
        }
        val listed = classified.filter { includeClosed || !it.dated.closed }
        return CapacityPlan(listed.map { it.item }, removalsOf(listed, sprints, existingPeriods, window, includeClosed))
    }

    private fun datedOf(sprint: FlowMirrorSprint, zone: ZoneId, window: LocalDate): Dated {
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

    private fun claimOf(row: Dated, claimedEnd: LocalDate?, calendar: WorkingCalendar): Claim {
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
    private fun longClaims(dated: List<Dated>, calendar: WorkingCalendar): Map<Dated, Claim> {
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

    private fun figureOf(sprint: FlowMirrorSprint, workingDays: Long): Figure {
        val total = checkNotNull(sprint.capacityMd)
        val perWeek = BigDecimal(WORKING_DAYS_PER_WEEK).multiply(total).divide(BigDecimal(workingDays), MD_SCALE, RoundingMode.HALF_UP)
        // The bounds are the capacity period's own: the same rule that would refuse the figure on a manual write.
        val inRange = try {
            validateManDays(perWeek.toDouble(), "mdPerWeek")
            true
        } catch (_: BadRequestException) {
            false
        }
        return Figure(perWeek, inRange)
    }

    private fun itemOf(row: Dated, claim: Claim, period: CapacityPeriodRow?, manual: List<CapacityPeriodRow>): CapacityImportItem {
        val figure = if (claim.skip == null) figureOf(row.sprint, checkNotNull(claim.figureDays)) else null
        val reason = claim.skip ?: if (figure?.inRange == false) CapacitySkipReason.OUT_OF_RANGE else null
        val long = if (row.longWindow) listOf(CapacityInfo(CapacityInfoCode.LONG_WINDOW, null)) else emptyList()
        if (reason != null || figure == null) return build(row, claim, null, CapacityAction.SKIP, reason, long, null)
        val action = when {
            period == null -> CapacityAction.CREATE
            period.source == CapacitySource.MANUAL -> CapacityAction.MANUAL_PERIOD
            period.flowSprintId == row.sprint.sprintId && period.flowSprintName == row.sprint.name &&
                period.mdPerWeek.compareTo(figure.mdPerWeek) == 0 -> CapacityAction.UNCHANGED
            else -> CapacityAction.UPDATE
        }
        val from = checkNotNull(claim.effectiveFrom)
        val end = checkNotNull(row.end)
        val inside = manual.filter { it.effectiveFrom > from && it.effectiveFrom <= end }
            .map { CapacityInfo(CapacityInfoCode.MANUAL_PERIOD_INSIDE, it.effectiveFrom.toString()) }
        val zero = if (row.sprint.capacityMd?.signum() == 0) listOf(CapacityInfo(CapacityInfoCode.ZERO_CAPACITY, null)) else emptyList()
        // A fixed per-sprint figure spread over a window longer than the days the row holds: say so, with the window's working days.
        val own = claim.figureDays
        val fixed = if (own != null && own > checkNotNull(claim.workingDays)) {
            listOf(CapacityInfo(CapacityInfoCode.FIXED_FIGURE, null, own.toInt()))
        } else {
            emptyList()
        }
        val existing = period?.let { CapacityExisting(it.id, it.mdPerWeek.toDouble(), it.source) }
        return build(row, claim, figure, action, null, zero + inside + long + fixed, existing)
    }

    @Suppress("LongParameterList") // one wire row's fields, assembled in one place
    private fun build(
        row: Dated,
        claim: Claim,
        figure: Figure?,
        action: CapacityAction,
        reason: CapacitySkipReason?,
        infos: List<CapacityInfo>,
        existing: CapacityExisting?,
    ) = CapacityImportItem(
        sprintId = row.sprint.sprintId,
        name = row.sprint.name,
        state = row.sprint.state,
        start = row.start?.toString(),
        end = row.end?.toString(),
        effectiveFrom = claim.effectiveFrom?.toString(),
        workingDays = claim.workingDays?.toInt(),
        flowMd = row.sprint.capacityMd?.toDouble(),
        mdPerWeek = figure?.takeIf { it.inRange }?.mdPerWeek?.toDouble(),
        action = action,
        reason = reason,
        infos = infos,
        ticked = !row.closed && !row.longWindow && row.sprint.capacityMd?.signum() != 0 &&
            (action == CapacityAction.CREATE || action == CapacityAction.UPDATE),
        existing = existing,
    )

    /**
     * The FLOW periods a refused row keeps: a listed sprint that is SKIP but still holds days (`NO_CAPACITY`, `OUT_OF_RANGE`,
     * `NO_WORKING_DAY`, `NO_DATES`; not one wholly inside earlier sprints) keeps the period at its own `effectiveFrom` - for `NO_DATES`
     * the period carrying its sprint id at its start day - because Astrolabe keeps the last good figure rather than inviting its
     * deletion when it cannot compute a new one. Its OTHER old FLOW periods are still offered.
     */
    private fun keptByRefusedRows(listed: List<Classified>, existing: List<CapacityPeriodRow>): Set<UInt> {
        val flow = existing.filter { it.source == CapacitySource.FLOW }
        return listed.filter { it.item.action == CapacityAction.SKIP && it.item.reason != CapacitySkipReason.OVERLAPS }.mapNotNull { row ->
            val at = row.claim.effectiveFrom
            when {
                at != null -> flow.firstOrNull { it.effectiveFrom == at }
                row.dated.hasSpan -> null // wholly inside earlier sprints, whatever the refusal says: no day held, nothing kept
                else -> row.dated.start?.let { start ->
                    flow.firstOrNull { it.effectiveFrom == start && it.flowSprintId == row.dated.sprint.sprintId }
                }
            }?.id
        }.toSet()
    }

    private fun removalsOf(
        listed: List<Classified>,
        sprints: List<FlowMirrorSprint>,
        existing: List<CapacityPeriodRow>,
        window: LocalDate,
        includeClosed: Boolean,
    ): List<CapacityImportRemoval> {
        val inDocument = sprints.mapTo(HashSet()) { it.sprintId }
        val reused = listed.mapNotNull { it.item.existing?.periodId }.toSet() + keptByRefusedRows(listed, existing)
        val covered = listed.filter { it.covers }
        // (c): every LISTED sprint owns its FLOW periods, whatever its action or skip reason; the period an item reuses is excluded above.
        val ownerIds = listed.mapTo(HashSet()) { it.dated.sprint.sprintId }
        return existing.filter { it.source == CapacitySource.FLOW && it.id !in reused }.filter { period ->
            val gone = period.flowSprintId !in inDocument && (includeClosed || period.effectiveFrom >= window)
            val inside = covered.any {
                period.effectiveFrom > checkNotNull(it.claim.effectiveFrom) && period.effectiveFrom <= checkNotNull(it.dated.end)
            }
            gone || inside || period.flowSprintId in ownerIds
        }.sortedBy { it.effectiveFrom }.map {
            CapacityImportRemoval(it.id, it.effectiveFrom.toString(), it.mdPerWeek.toDouble(), it.flowSprintId, it.flowSprintName)
        }
    }
}
