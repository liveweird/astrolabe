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

private const val WORKING_DAYS_PER_WEEK = 5L
private const val MD_SCALE = 2

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
private class Dated(val sprint: FlowMirrorSprint, val start: LocalDate?, val end: LocalDate?, val closed: Boolean)

/**
 * What the sprint may claim: [effectiveFrom] is the first day its figure holds (its start, or the day after the previous kept sprint's
 * last day when they share one), [workingDays] the working days from there to its end; [skip] is the first rule that refuses it.
 */
private class Claim(val effectiveFrom: LocalDate?, val workingDays: Long?, val skip: CapacitySkipReason?)

/** A classified sprint: the wire item, plus what the removal rules read. */
private class Classified(val dated: Dated, val claim: Claim, val item: CapacityImportItem) {
    /** Whether the import covers the sprint's span with its figure (so a stale Flow period inside it must go). */
    val covers: Boolean
        get() = !dated.closed && item.action in setOf(CapacityAction.CREATE, CapacityAction.UPDATE, CapacityAction.UNCHANGED)
}

/** The weekly figure of a sprint; [inRange] says it passes the man-day bounds of a capacity period. */
private class Figure(val mdPerWeek: BigDecimal, val inRange: Boolean)

/**
 * The capacity import (pure: no clock, no database, no zone lookup): turns a Flow team's sprints into the man-days-per-week periods the
 * team would carry, against the team's ACTIVE periods. The rule, in the user's words: a sprint's man-days are spread over the sprint's
 * WORKING days (Astrolabe's calendar, holidays included), so the weekly capacity Astrolabe computes over the sprint adds up to what Flow
 * says (within rounding); one period per sprint; a period Flow wrote is Flow's to update and remove, a hand-entered one is NEVER changed.
 *
 * **The span** is Flow's (`DeriveSprintStep`, `metrics.md` A42): `spanEnd = min(endAt, completeAt)` when both exist (a sprint completed
 * early ends at the completion), else whichever exists; `end = dayOf(max(startAt, spanEnd - 1 ms))` in [zone] (a zero-length sprint
 * is one day; `spanEnd < startAt` stays NO_DATES), so an end at local midnight adds no day. Consecutive Jira sprints share the day
 * one ends and the next starts on; that day belongs to the EARLIER sprint, so the later one holds its figure from
 * `effectiveFrom = max(start, previousKeptEnd + 1 day)`. Only a start BEFORE the previous kept sprint's end is a genuine overlap.
 *
 * Per sprint, in start order (undated last, then by id), the first rule that fires: no start, no end, or an end before the start -
 * [CapacitySkipReason.NO_DATES]; no capacity - `NO_CAPACITY`; `start < previousKeptEnd`, or `effectiveFrom > end` -
 * `OVERLAPS` (the earlier start wins, whatever the toggles; "kept" = got past these rules and the next); no working day from
 * `effectiveFrom` to `end` - `NO_WORKING_DAY`; then
 * `mdPerWeek = round2(5 x capacityMd / workingDays)` (HALF_UP), beyond the man-day bounds - `OUT_OF_RANGE`. Otherwise against the ACTIVE
 * period that starts on `effectiveFrom`: none - CREATE; a FLOW one - UPDATE when its figure, its sprint or its name differ (the WIP limit
 * is kept: Flow has none), else UNCHANGED; a MANUAL one - MANUAL_PERIOD. Every MANUAL period starting inside `(effectiveFrom, end]` adds
 * the info `MANUAL_PERIOD_INSIDE(date)`. A sprint with 0 man-days is planned like any other but never ticked, with the info
 * `ZERO_CAPACITY` (Flow's DEFAULT figure is 0 for a team without members).
 *
 * A sprint whose `end` is before `from` (default [today]) is CLOSED: listed only with [includeClosed] and never ticked. A sprint is ticked
 * when it is not closed, not zero-capacity and a CREATE or an UPDATE.
 *
 * `removals[]` are this team's FLOW periods that no listed sprint reuses and that (a) belong to a sprint missing from [sprints] and lie in
 * the import's window (`date >= from`, or any date with [includeClosed]: a sprint that aged out of Flow's document keeps its history),
 * (b) start inside `(effectiveFrom, end]` of a sprint the import covers (not closed; CREATE, UPDATE or UNCHANGED), where they would cut
 * the sprint's figure short, or (c) belong to such a covered sprint without being the period its item reuses (a sprint moved later).
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
        var keptEnd: LocalDate? = null
        val classified = dated.map { row ->
            val claim = claimOf(row, keptEnd, calendar)
            if (claim.skip == null) keptEnd = row.end
            Classified(row, claim, itemOf(row, claim, claim.effectiveFrom?.let(byDate::get), manual))
        }
        val listed = classified.filter { includeClosed || !it.dated.closed }
        return CapacityPlan(listed.map { it.item }, removalsOf(listed, sprints, existingPeriods, window, includeClosed))
    }

    private fun datedOf(sprint: FlowMirrorSprint, zone: ZoneId, window: LocalDate): Dated {
        fun dateOf(instant: Long): LocalDate = Instant.ofEpochMilli(instant).atZone(zone).toLocalDate()
        val startAt = sprint.startAt
        val spanEnd = listOfNotNull(sprint.endAt, sprint.completeAt).minOrNull()
        // An end before the start is shown as sent and stays NO_DATES; else Flow's `max(start, end - 1 ms)` (zero-length = one day).
        val end = when {
            startAt == null || spanEnd == null -> null
            spanEnd < startAt -> dateOf(spanEnd)
            else -> dateOf(maxOf(startAt, spanEnd - 1))
        }
        return Dated(sprint, startAt?.let(::dateOf), end, closed = end != null && end < window)
    }

    private fun claimOf(row: Dated, keptEnd: LocalDate?, calendar: WorkingCalendar): Claim {
        val start = row.start
        val end = row.end
        if (start == null || end == null || end < start) return Claim(null, null, CapacitySkipReason.NO_DATES)
        val effectiveFrom = if (keptEnd == null) start else maxOf(start, keptEnd.plusDays(1))
        val overlapped = (keptEnd != null && start < keptEnd) || effectiveFrom > end
        val days = if (overlapped) null else calendar.workingDaysBetween(effectiveFrom, end)
        val skip = when {
            row.sprint.capacityMd == null -> CapacitySkipReason.NO_CAPACITY
            overlapped -> CapacitySkipReason.OVERLAPS
            days == 0L -> CapacitySkipReason.NO_WORKING_DAY
            else -> null
        }
        return Claim(effectiveFrom.takeUnless { overlapped }, days, skip)
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
        val figure = if (claim.skip == null) figureOf(row.sprint, checkNotNull(claim.workingDays)) else null
        val reason = claim.skip ?: if (figure?.inRange == false) CapacitySkipReason.OUT_OF_RANGE else null
        if (reason != null || figure == null) return build(row, claim, null, CapacityAction.SKIP, reason, emptyList(), null)
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
        val existing = period?.let { CapacityExisting(it.id, it.mdPerWeek.toDouble(), it.source) }
        return build(row, claim, figure, action, null, zero + inside, existing)
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
        ticked = !row.closed && row.sprint.capacityMd?.signum() != 0 &&
            (action == CapacityAction.CREATE || action == CapacityAction.UPDATE),
        existing = existing,
    )

    private fun removalsOf(
        listed: List<Classified>,
        sprints: List<FlowMirrorSprint>,
        existing: List<CapacityPeriodRow>,
        window: LocalDate,
        includeClosed: Boolean,
    ): List<CapacityImportRemoval> {
        val inDocument = sprints.mapTo(HashSet()) { it.sprintId }
        val reused = listed.mapNotNull { it.item.existing?.periodId }.toSet()
        val covered = listed.filter { it.covers }
        val coveredIds = covered.mapTo(HashSet()) { it.dated.sprint.sprintId }
        return existing.filter { it.source == CapacitySource.FLOW && it.id !in reused }.filter { period ->
            val gone = period.flowSprintId !in inDocument && (includeClosed || period.effectiveFrom >= window)
            val inside = covered.any {
                period.effectiveFrom > checkNotNull(it.claim.effectiveFrom) && period.effectiveFrom <= checkNotNull(it.dated.end)
            }
            gone || inside || period.flowSprintId in coveredIds
        }.sortedBy { it.effectiveFrom }.map {
            CapacityImportRemoval(it.id, it.effectiveFrom.toString(), it.mdPerWeek.toDouble(), it.flowSprintId, it.flowSprintName)
        }
    }
}
