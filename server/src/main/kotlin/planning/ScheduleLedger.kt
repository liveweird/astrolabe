package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import java.math.BigDecimal
import java.math.BigInteger
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/*
 * The scheduling kernel's per-day ledger (v0.8.0; `planning-model.md` "The auto-proposal"): for every working day from the team's first
 * USABLE day to the horizon, the daily capacity, the WIP limit, the exact share, and what the milestones placed so far already use;
 * and, per ISO week, the exact capacity of ALL its working days against the exact load booked on all of them (days before the first
 * candidate day included), so a proposal never adds load to a week the team view would show overloaded.
 * Pure (the calendar and the periods are parameters). All arithmetic is exact [Fraction]s; days are working-day INDEXES of the
 * [WorkingCalendar], so a holiday simply is not a day and consecutive indexes are consecutive working days.
 */

private const val WORKING_DAYS_PER_WEEK = 5
private const val NO_LIMIT = Int.MAX_VALUE
private const val DAYS_PER_WEEK = 7L

/** A placed span: the first and last working-day INDEX and the even daily rate (`E / n`) it adds. */
internal class Slot(val first: Long, val last: Long, val rate: Fraction)

/** [estimate] as an exact fraction (a negative scale is normalised first, as the load kernel's share does). */
internal fun exactOf(estimate: BigDecimal): Fraction {
    val value = if (estimate.scale() < 0) estimate.setScale(0) else estimate
    return Fraction.reduced(value.unscaledValue(), BigInteger.TEN.pow(value.scale()))
}

/** This fraction spread over [days] days (`this / days`). */
internal fun Fraction.over(days: Int): Fraction = Fraction.reduced(num, den * BigInteger.valueOf(days.toLong()))

/** This fraction times [days], unreduced: only ever compared. */
private fun Fraction.scaledBy(days: Int): Fraction = Fraction(num * BigInteger.valueOf(days.toLong()), den)

/** Whether a day under this period can take proposed work: some capacity, and a WIP limit that admits at least one milestone. */
private fun CapacityPeriod.takesWork(): Boolean = mdPerWeek.signum() > 0 && (wipLimit ?: 1) > 0

/**
 * The first USABLE working day on or after [from] (a working day in a period with capacity above zero), or null when there is none at
 * all (no period, or on hold from [from] on). O(periods): it jumps across a stretch without capacity to the next period's start, never
 * day by day. [periods] must be ordered by `effectiveFrom`.
 */
internal fun usableDayOnOrAfter(from: LocalDate, periods: List<CapacityPeriod>, calendar: WorkingCalendar): LocalDate? {
    var day = calendar.nextWorkingDayOnOrAfter(from)
    while (true) {
        if (periodOn(day, periods)?.takesWork() == true) return day
        val next = periods.firstOrNull { it.effectiveFrom.isAfter(day) && it.takesWork() } ?: return null
        day = calendar.nextWorkingDayOnOrAfter(next.effectiveFrom)
    }
}

/**
 * The ledger of the working days `[firstUsable, firstUsable + horizonWeeks weeks)`. `dailyCap(d)` is the period's `mdPerWeek / 5` (the
 * fixed divisor of [weekCapacity]), `share(d)` that over the WIP limit (the whole capacity when there is none). `wip` and `used` start at
 * zero; [add] books a milestone's days. A day is unusable (cap null or 0, on hold) and ends every span that would run into it. A
 * candidate must fit TWO levels: every day (`used + rate <= dailyCap`, WIP place) and every ISO week it touches
 * (`weekUsed + rate * its days there <= weekCap`, the sums of the view's own week figures, exact). The per-week level matters when
 * fixed load overbooks a day or sits on a day without capacity: the daily test alone would let the week overflow.
 */
internal class ScheduleLedger(
    firstUsable: LocalDate,
    private val periods: List<CapacityPeriod>,
    private val calendar: WorkingCalendar,
    horizonWeeks: Int,
) {
    /** The working-day index of the first usable day: ledger position `i` is the index `lo + i`. */
    val lo: Long = calendar.workingDayIndex(firstUsable)
    private val size: Int
    private val usable: BooleanArray
    private val dailyCap: Array<Fraction>
    private val share: Array<Fraction>
    private val limit: IntArray
    private val wip: IntArray
    private val used: Array<Fraction>

    /** `nextUsable[i]` = the first usable position at or after `i` (`size` = none); `stretchEnd[i]` the end of `i`'s usable run. */
    private val nextUsable: IntArray
    private val stretchEnd: IntArray

    /** The greatest share from `i` to the end of its usable run: the exact pruning bound of [hopelessFrom]. */
    private val sufMaxShare: Array<Fraction>

    /** The ISO weeks: `weekOf[i]` is the ordinal of position `i`'s week; `weekCap`/`weekUsed` cover ALL the week's working days. */
    private val firstMonday: LocalDate = mondayOf(firstUsable)
    private val weekOf: IntArray
    private val weekCap: Array<Fraction>
    private val weekUsed: Array<Fraction>

    /** The last working-day index of the last ledger week (a fixed booking after the horizon, inside that week, still loads it). */
    private val lastWeekIndex: Long

    init {
        require(horizonWeeks >= 1) { "horizonWeeks must be at least 1" }
        val horizonEnd = firstUsable.plusWeeks(horizonWeeks.toLong()).minusDays(1)
        size = (calendar.workingDayIndex(horizonEnd) - lo + 1).toInt()
        usable = BooleanArray(size)
        dailyCap = Array(size) { Fraction.ZERO }
        share = Array(size) { Fraction.ZERO }
        limit = IntArray(size) { NO_LIMIT }
        wip = IntArray(size)
        used = Array(size) { Fraction.ZERO }
        weekOf = IntArray(size)
        for (i in 0 until size) {
            val day = calendar.workingDayOfIndex(lo + i)
            weekOf[i] = ChronoUnit.WEEKS.between(firstMonday, mondayOf(day)).toInt()
            val period = periodOn(day, periods)?.takeIf { it.takesWork() } ?: continue
            val perDay = exactOf(period.mdPerWeek).over(WORKING_DAYS_PER_WEEK)
            usable[i] = true
            dailyCap[i] = perDay
            limit[i] = period.wipLimit ?: NO_LIMIT
            share[i] = period.wipLimit?.let { perDay.over(it) } ?: perDay
        }
        nextUsable = IntArray(size + 1) { size }
        stretchEnd = IntArray(size)
        sufMaxShare = Array(size) { Fraction.ZERO }
        for (i in size - 1 downTo 0) {
            nextUsable[i] = if (usable[i]) i else nextUsable[i + 1]
            if (!usable[i]) continue
            val continues = i + 1 < size && usable[i + 1]
            stretchEnd[i] = if (continues) stretchEnd[i + 1] else i
            sufMaxShare[i] = if (continues && sufMaxShare[i + 1] > share[i]) sufMaxShare[i + 1] else share[i]
        }
        val weeks = weekOf[size - 1] + 1
        weekCap = Array(weeks) { weekCapacityOf(firstMonday.plusWeeks(it.toLong())) }
        weekUsed = Array(weeks) { Fraction.ZERO }
        lastWeekIndex = calendar.workingDayIndex(firstMonday.plusWeeks(weeks.toLong()).minusDays(1))
    }

    /** The exact capacity of the week at [monday]: `mdPerWeek / 5` over its working days (the view's `weekCapacity`, unrounded). */
    private fun weekCapacityOf(monday: LocalDate): Fraction =
        (0L until DAYS_PER_WEEK).map(monday::plusDays).filter(calendar::isWorkingDay).fold(Fraction.ZERO) { sum, day ->
            val perWeek = capacityOn(day, periods) ?: return@fold sum
            sum + exactOf(perWeek).over(WORKING_DAYS_PER_WEEK)
        }

    /**
     * Books the working-day indexes [first]..[last]: one more milestone in progress and [rate] more load on each day inside the ledger,
     * and [rate] more load on its ISO week for EVERY day, also those before the first candidate day (the view counts them).
     */
    fun add(first: Long, last: Long, rate: Fraction) {
        val firstWeekIndex = calendar.workingDayIndex(firstMonday)
        for (index in maxOf(first, firstWeekIndex)..minOf(last, lastWeekIndex)) {
            val week = ChronoUnit.WEEKS.between(firstMonday, mondayOf(calendar.workingDayOfIndex(index))).toInt()
            if (week in weekUsed.indices) weekUsed[week] = weekUsed[week] + rate
            if (index < lo || index >= lo + size) continue
            val i = (index - lo).toInt()
            wip[i] += 1
            used[i] = used[i] + rate
        }
    }

    /**
     * The earliest fit for an estimate of [estimate] man-days starting at working-day index [from] or later: the first start whose
     * span has [n][Slot] usable days (the smallest `n` with `E <= n * min share`, 1 for a 0 MD estimate), whose every day has a WIP
     * place and room for the even rate `E / n`, and (when [endAtLeast] is set) whose last day reaches that index. Null = nothing
     * fits before the horizon. A start that cannot hold any span of its stretch is skipped with its whole run (exact: a later start
     * has fewer days and a no greater share); every other conflict moves the start by ONE working day, because the span length (and
     * so the rate) depends on the start.
     */
    fun findSlot(from: Long, estimate: BigDecimal, endAtLeast: Long?): Slot? {
        if (endAtLeast != null && endAtLeast > lo + size - 1) return null
        val e = exactOf(estimate)
        var i = (maxOf(from, lo) - lo).coerceAtMost(size.toLong()).toInt()
        while (i < size) {
            i = nextUsable[i]
            if (i >= size) return null
            if (hopelessFrom(i, e)) {
                i = stretchEnd[i] + 1
                continue
            }
            slotAt(i, e, endAtLeast)?.let { return it }
            i++
        }
        return null
    }

    private fun isZero(e: Fraction) = e.num.signum() == 0

    /** No span starting at or after [i] in its run can carry [e]: even every remaining day at the run's best share is too little. */
    private fun hopelessFrom(i: Int, e: Fraction): Boolean = !isZero(e) && e > sufMaxShare[i].scaledBy(stretchEnd[i] - i + 1)

    /** The cheap exact tests on the first day, which every span starting at [i] covers. */
    private fun blockedAt(i: Int, e: Fraction): Boolean =
        wip[i] >= limit[i] || (!isZero(e) && (used[i] >= dailyCap[i] || weekUsed[weekOf[i]] >= weekCap[weekOf[i]]))

    private fun slotAt(i: Int, e: Fraction, endAtLeast: Long?): Slot? {
        if (blockedAt(i, e)) return null
        val n = daysFor(i, e) ?: return null
        val last = i + n - 1
        if (endAtLeast != null && lo + last < endAtLeast) return null
        val rate = e.over(n)
        val fits = (i..last).all { wip[it] < limit[it] && (isZero(e) || rate <= dailyCap[it] - used[it]) }
        return if (fits && (isZero(e) || weeksFit(i, last, rate))) Slot(lo + i, lo + last, rate) else null
    }

    /** Whether the rate fits every ISO week the span [i]..[last] touches: `weekUsed + rate * (its days in the week) <= weekCap`. */
    private fun weeksFit(i: Int, last: Int, rate: Fraction): Boolean {
        var day = i
        while (day <= last) {
            val week = weekOf[day]
            var days = 0
            while (day <= last && weekOf[day] == week) {
                days++
                day++
            }
            if (rate.scaledBy(days) > weekCap[week] - weekUsed[week]) return false
        }
        return true
    }

    /** The smallest `n` such that `e <= n * min(share[i..i+n-1])` over consecutive usable days; null if the run ends first. */
    private fun daysFor(i: Int, e: Fraction): Int? {
        if (isZero(e)) return 1
        var minShare = share[i]
        var day = i
        while (true) {
            val n = day - i + 1
            if (e <= minShare.scaledBy(n)) return n
            day++
            if (day >= size || !usable[day]) return null
            if (share[day] < minShare) minShare = share[day]
        }
    }

    /** The date of working-day [index]. */
    fun dateOf(index: Long): LocalDate = calendar.workingDayOfIndex(index)
}
