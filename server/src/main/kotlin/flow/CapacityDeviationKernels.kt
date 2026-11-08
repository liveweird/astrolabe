package ch.nokillswit.flow

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.CapacityPeriod
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.planning.capacityOn
import ch.nokillswit.teams.CapacityPeriodRow
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate

/** Q5a, the ONE home of the threshold: a sprint deviates when its two ROUNDED figures differ by at least this many man-days. */
internal val CAPACITY_DEVIATION_THRESHOLD_MD: BigDecimal = BigDecimal("0.50")

private val WORKING_DAYS_PER_WEEK = BigDecimal(5)
private const val MD_SCALE = 2
private const val SHARE_SCALE = 6

/**
 * The capacity deviation of ONE bound team (pure: no clock, no database), comparing the plan's capacity with what the capacity import
 * would make it carry, sprint by sprint. [deviations] takes the import's own [CapacityPlan] (`CapacityImportKernels.plan(..., from = null,
 * includeClosed = false)`: the windows, the days each sprint holds and the figures are the import's, so preview and deviation can never
 * disagree) and the team's ACTIVE periods. The rules, in order:
 *
 * 1. [gone] - exactly one `TEAM_GONE` WARNING (a gone team has no sprints in the mirror), nothing else.
 * 2. A row that is `SKIP` (no dates, no capacity, overlaps, no working day, out of range: Flow has no comparable figure) or a
 *    `LONG_WINDOW` (a partial figure the import never ticks) is silent. Every other row, a `MANUAL_PERIOD` and a `ZERO_CAPACITY` one
 *    included, is compared.
 * 3. The days held are the working days of `[effectiveFrom, end]` (the import's claim); `flowMd = round2(mdPerWeek x workingDays / 5)` is
 *    what the plan carries over them after a clean import (Flow's own total is [CapacityDeviationDetail.flowTotalMd]: it differs for a
 *    fixed per-sprint figure sharing days with an earlier sprint, which the import spreads over the sprint's own window).
 * 4. No period in force on ANY of those days - `CAPACITY_MISSING` INFO, unless Flow's figure is 0 too (silent: both say nobody).
 *    Otherwise `planMd` is the team view's arithmetic over the held days (`weekCapacity`: each day's figure over 5 at scale 6, the
 *    sum rounded once, HALF_UP, to two decimals; a day before the first period counts 0), and `abs(planMd - flowMd) >= 0.50` on the
 *    ROUNDED figures is `CAPACITY_DIFFERS`: WARNING when the plan has more, INFO when less.
 *
 * The result is ordered by `effectiveFrom`, then sprint id. Both sides use the same calendar, so a holiday alone never raises one.
 */
object CapacityDeviationKernels {
    fun deviations(
        plan: CapacityPlan,
        periods: List<CapacityPeriodRow>,
        calendar: WorkingCalendar,
        gone: Boolean,
    ): List<CapacityDeviation> {
        if (gone) return listOf(CapacityDeviation(CapacityDeviationKind.TEAM_GONE, DeviationSeverity.WARNING, NO_DETAIL))
        val inForce = periods.map { CapacityPeriod(it.effectiveFrom, it.mdPerWeek, it.wipLimit) }
        return plan.items.mapNotNull { deviationOf(it, inForce, calendar) }
            .sortedWith(compareBy<CapacityDeviation>({ it.detail.effectiveFrom }, { it.detail.sprintId }))
    }

    private val NO_DETAIL = CapacityDeviationDetail(null, null, null, null, null, null, null, null, null, null)

    private fun deviationOf(item: CapacityImportItem, periods: List<CapacityPeriod>, calendar: WorkingCalendar): CapacityDeviation? {
        if (item.action == CapacityAction.SKIP || item.infos.any { it.code == CapacityInfoCode.LONG_WINDOW }) return null
        // Not a SKIP: the row has its dates, its working days and its figure (the import's `mdPerWeek` is null exactly for SKIP rows).
        val effectiveFrom = LocalDate.parse(checkNotNull(item.effectiveFrom))
        val end = LocalDate.parse(checkNotNull(item.end))
        val workingDays = checkNotNull(item.workingDays)
        val flowMd = BigDecimal.valueOf(checkNotNull(item.mdPerWeek)).multiply(BigDecimal(workingDays))
            .divide(WORKING_DAYS_PER_WEEK, MD_SCALE, RoundingMode.HALF_UP)
        val covered = generateSequence(effectiveFrom) { it.plusDays(1) }.takeWhile { !it.isAfter(end) }.filter(calendar::isWorkingDay)
            .mapNotNull { capacityOn(it, periods) }.toList()
        val planMd = covered.takeIf { it.isNotEmpty() }?.let(::capacityOver)
        val gap = planMd?.subtract(flowMd)
        val detail = CapacityDeviationDetail(
            sprintId = item.sprintId,
            sprintName = item.name,
            start = item.start,
            end = item.end,
            effectiveFrom = item.effectiveFrom,
            workingDays = item.workingDays,
            flowMd = flowMd.toDouble(),
            flowTotalMd = item.flowMd,
            planMd = planMd?.toDouble(),
            gapMd = gap?.toDouble(),
        )
        // No period in force against Flow's 0 (a ZERO_CAPACITY sprint): both sides say "nobody", so it is not a missing figure.
        if (planMd == null && flowMd.signum() == 0) return null
        return kindAndSeverityOf(gap)?.let { (kind, severity) -> CapacityDeviation(kind, severity, detail) }
    }

    /** The kind and severity a [gap] earns, or null for a sprint in line; a null gap is a sprint with no capacity in the plan at all. */
    private fun kindAndSeverityOf(gap: BigDecimal?): Pair<CapacityDeviationKind, DeviationSeverity>? = when {
        gap == null -> CapacityDeviationKind.CAPACITY_MISSING to DeviationSeverity.INFO
        gap.abs() < CAPACITY_DEVIATION_THRESHOLD_MD -> null
        // WARNING when the plan has MORE capacity than Flow, INFO when less.
        gap.signum() > 0 -> CapacityDeviationKind.CAPACITY_DIFFERS to DeviationSeverity.WARNING
        else -> CapacityDeviationKind.CAPACITY_DIFFERS to DeviationSeverity.INFO
    }

    /** The `weekCapacity` arithmetic over a sprint: each covered day's figure over 5 at scale 6, summed, rounded once to two decimals. */
    private fun capacityOver(figures: List<BigDecimal>): BigDecimal =
        figures.fold(BigDecimal.ZERO) { sum, md -> sum + md.divide(WORKING_DAYS_PER_WEEK, SHARE_SCALE, RoundingMode.HALF_UP) }
            .setScale(MD_SCALE, RoundingMode.HALF_UP)
}
