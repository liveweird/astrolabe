package ch.nokillswit.planning

import java.math.BigDecimal
import java.time.LocalDate

/*
 * A team's capacity then and now as pure functions (no I/O, no clock). A team's ACTIVE periods are a step function of the calendar
 * (`planning-model.md` "Team capacity periods"): a period holds from its `effectiveFrom` until the next period's, the last one without
 * end, and before the first there is NO capacity (null, which is not zero: zero is an explicit "on hold" figure). The comparison merges
 * the two step functions at the union of their breakpoints and reports every MAXIMAL range on which the two figures differ.
 */

/** What is in force on a day: the man-days per week and the WIP limit (null = none). Compared by value: `10.0` is `10.00`. */
data class CapacityFigure(val mdPerWeek: BigDecimal, val wipLimit: Int?) {
    fun sameAs(other: CapacityFigure?): Boolean = other != null && mdPerWeek.compareTo(other.mdPerWeek) == 0 && wipLimit == other.wipLimit
}

/** A figure in force from [from] to [to] inclusive ([to] null = without end). */
data class CapacityRange(val from: LocalDate, val to: LocalDate?, val figure: CapacityFigure)

/** A range on which the figure then ([then]) and now ([now]) differ; null = no capacity in force on that side. */
data class CapacityChange(val from: LocalDate, val to: LocalDate?, val then: CapacityFigure?, val now: CapacityFigure?)

object BaselineCapacityKernels {
    /** The step function of one team's [periods] as ranges, by start: each runs to the day before the next period starts. */
    fun ranges(periods: List<CapacityPeriod>): List<CapacityRange> {
        val sorted = periods.sortedBy { it.effectiveFrom }
        return sorted.mapIndexed { i, p ->
            CapacityRange(p.effectiveFrom, sorted.getOrNull(i + 1)?.effectiveFrom?.minusDays(1), CapacityFigure(p.mdPerWeek, p.wipLimit))
        }
    }

    /**
     * The maximal ranges on which one team's capacity [then] and [now] (each its ACTIVE periods) differ, by start. Adjacent segments with
     * the same pair of figures are ONE range, so splitting a period into two equal ones is no change; two differing neighbours with
     * different pairs stay two. A side with no period has no capacity at all.
     */
    fun changes(then: List<CapacityPeriod>, now: List<CapacityPeriod>): List<CapacityChange> {
        val before = ranges(then)
        val after = ranges(now)
        val points = (before.map { it.from } + after.map { it.from }).distinct().sorted()
        val changes = mutableListOf<CapacityChange>()
        points.forEachIndexed { i, from ->
            val figureThen = figureOn(before, from)
            val figureNow = figureOn(after, from)
            if (figureThen == null && figureNow == null) return@forEachIndexed
            if (figureThen != null && figureThen.sameAs(figureNow)) return@forEachIndexed
            val to = points.getOrNull(i + 1)?.minusDays(1)
            val last = changes.lastOrNull()
            if (last != null && last.to?.plusDays(1) == from && same(last.then, figureThen) && same(last.now, figureNow)) {
                changes[changes.size - 1] = last.copy(to = to)
            } else {
                changes += CapacityChange(from, to, figureThen, figureNow)
            }
        }
        return changes
    }

    private fun figureOn(ranges: List<CapacityRange>, day: LocalDate): CapacityFigure? =
        ranges.lastOrNull { it.from <= day }?.figure

    private fun same(a: CapacityFigure?, b: CapacityFigure?): Boolean = if (a == null) b == null else a.sameAs(b)
}
