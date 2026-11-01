package ch.nokillswit.planning

import ch.nokillswit.infra.time.WorkingCalendar
import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters

/*
 * The weekly load, capacity and WIP of a team as pure kernels (no I/O, no clock; the `CapacityKernels.kt` idiom: top-level functions and
 * data classes, exact BigDecimal, one HALF_UP rounding per figure). The team view (`GET /views/team/{id}`) feeds them; the hand-counted
 * vectors are `LoadKernelsTest`, the rules `planning-model.md` "The team view".
 *
 * A WEEK is an ISO week keyed by its Monday; its WORKING days are those of the [WorkingCalendar] the kernel is handed (Monday-Friday
 * minus its holidays). The capacity DIVISOR stays [WORKING_DAYS_PER_WEEK] (5) in a holiday week: the holiday is an uncovered day, so a
 * 10 MD/week team has 8.00 in a week with one holiday, and the milestone spread over the remaining days is overloaded against it.
 */

/** The most weeks the team view reports (about ten years); a longer range is cut at this many weeks from its start. */
const val MAX_LOAD_WEEKS = 520

private const val WORKING_DAYS_PER_WEEK = 5
private const val DAYS_PER_WEEK = 7L
private const val MONEY_SCALE = 2
private const val SHARE_SCALE = 6

/** A scheduled milestone as the load sees it: its inclusive [span] and its man-day [estimateMd]. */
data class LoadItem(val span: DaySpan, val estimateMd: BigDecimal)

/** A capacity period: in force from [effectiveFrom] (any date) until the next period; [wipLimit] null = no limit. */
data class CapacityPeriod(val effectiveFrom: LocalDate, val mdPerWeek: BigDecimal, val wipLimit: Int?)

/**
 * One ISO week. [load] and [capacity] are rounded `HALF_UP` to two decimals and [overloaded] compares the two ROUNDED figures, so what
 * is shown is what is flagged; [capacity] is null when no period is in force on any working day of the week (never flagged). [overloadMd]
 * is `load - capacity`, only when overloaded. [maxWip] is the week's peak WIP and [wipExceeded] whether some working day exceeds the
 * limit in force THAT day.
 */
data class WeekLoad(
    val weekStart: LocalDate,
    val load: BigDecimal,
    val capacity: BigDecimal?,
    val overloaded: Boolean,
    val overloadMd: BigDecimal?,
    val maxWip: Int,
    val wipExceeded: Boolean,
)

/** The weeks the view reports: [span] runs from a Monday to a Sunday; [truncated] when the range was cut at [MAX_LOAD_WEEKS]. */
data class LoadWindow(val span: DaySpan, val truncated: Boolean)

/** The Monday of [date]'s ISO week. */
fun mondayOf(date: LocalDate): LocalDate = date.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))

/**
 * The window of [spans]: from the earliest start's Monday to the latest end's Sunday, capped at [MAX_LOAD_WEEKS] weeks counted from the
 * start (then [LoadWindow.truncated]); null when there are no spans.
 */
fun loadWindow(spans: Iterable<DaySpan>): LoadWindow? {
    val derived = SpanKernels.derivedSpan(spans) ?: return null
    val start = mondayOf(derived.start)
    val end = mondayOf(derived.end).plusDays(DAYS_PER_WEEK - 1)
    val weeks = ChronoUnit.WEEKS.between(start, end.plusDays(1))
    if (weeks <= MAX_LOAD_WEEKS) return LoadWindow(DaySpan(start, end), truncated = false)
    return LoadWindow(DaySpan(start, start.plusWeeks(MAX_LOAD_WEEKS.toLong()).minusDays(1)), truncated = true)
}

/** The period in force on [day]: the one with the greatest `effectiveFrom <= day`; null before the first. */
fun periodOn(day: LocalDate, periods: List<CapacityPeriod>): CapacityPeriod? =
    periods.filter { !it.effectiveFrom.isAfter(day) }.maxByOrNull { it.effectiveFrom }

/** The man-days per week in force on [day] ([periodOn]'s), or null before the first period. */
fun capacityOn(day: LocalDate, periods: List<CapacityPeriod>): BigDecimal? = periodOn(day, periods)?.mdPerWeek

/**
 * The capacity of the week starting [monday]: the sum over its working days of the capacity in force that day, over 5 (each share at
 * scale 6 - exact for a two-decimal figure - the sum rounded `HALF_UP` to two decimals), so a period starting mid-week is prorated by
 * working days and a weekend `effectiveFrom` needs no special case. Working days before the first period contribute 0; null when NO
 * working day of the week is covered ("no capacity", never zero).
 */
fun weekCapacity(monday: LocalDate, periods: List<CapacityPeriod>, calendar: WorkingCalendar): BigDecimal? {
    val shares = workingDaysOf(monday, calendar).mapNotNull { capacityOn(it, periods) }
    if (shares.isEmpty()) return null
    val divisor = BigDecimal(WORKING_DAYS_PER_WEEK)
    return shares.fold(BigDecimal.ZERO) { sum, md -> sum + md.divide(divisor, SHARE_SCALE, RoundingMode.HALF_UP) }
        .setScale(MONEY_SCALE, RoundingMode.HALF_UP)
}

/** The WIP limit in force on [day] ([periodOn]'s); null = no limit (no period yet, or a period without one). */
fun wipLimitOn(day: LocalDate, periods: List<CapacityPeriod>): Int? = periodOn(day, periods)?.wipLimit

/** An item's EFFECTIVE span on the working-day index: first working day on or after the start to the last on or before the end. */
private class EffectiveSpan(val first: Long, val last: Long)

private fun effectiveSpanOf(span: DaySpan, calendar: WorkingCalendar) = EffectiveSpan(
    calendar.workingDayIndex(calendar.nextWorkingDayOnOrAfter(span.start)),
    calendar.workingDayIndex(calendar.previousWorkingDayOnOrBefore(span.end)),
)

private fun wipAt(day: LocalDate, spans: List<EffectiveSpan>, calendar: WorkingCalendar): Int {
    val index = calendar.workingDayIndex(day)
    return spans.count { it.first <= index && index <= it.last }
}

/**
 * The number of [items] whose effective span covers the working day [day] (the v0.4 dependency check's effective-span rule: a
 * weekend-only edge counts nothing). Counted by the index, so a weekend or holiday [day] reads the working day before it -
 * ask working days only.
 */
fun wipOn(day: LocalDate, items: List<LoadItem>, calendar: WorkingCalendar): Int =
    wipAt(day, items.map { effectiveSpanOf(it.span, calendar) }, calendar)

private fun workingDaysOf(monday: LocalDate, calendar: WorkingCalendar): List<LocalDate> =
    (0 until DAYS_PER_WEEK).map { monday.plusDays(it) }.filter(calendar::isWorkingDay)

/** An exact non-negative rational, reduced by the gcd: the load stays exact until its ONE rounding. */
private class Fraction(val num: BigInteger, val den: BigInteger) {
    operator fun plus(other: Fraction): Fraction = reduced(num * other.den + other.num * den, den * other.den)

    companion object {
        val ZERO = Fraction(BigInteger.ZERO, BigInteger.ONE)

        fun reduced(num: BigInteger, den: BigInteger): Fraction {
            val gcd = num.gcd(den)
            return if (gcd.signum() == 0 || gcd == BigInteger.ONE) Fraction(num, den) else Fraction(num / gcd, den / gcd)
        }
    }
}

/**
 * An item's EXACT share of the week [monday]..[sunday], in man-days: its estimate spread evenly over its working days, times the
 * working days it has inside the week, i.e. `E * inside / n` as a fraction (never divided first, so no digit is lost before the
 * single rounding); zero outside the week or for an item without a working day.
 */
private fun shareIn(item: LoadItem, monday: LocalDate, sunday: LocalDate, calendar: WorkingCalendar): Fraction {
    val total = calendar.workingDaysBetween(item.span.start, item.span.end)
    if (total <= 0) return Fraction.ZERO
    val inside = calendar.workingDaysBetween(maxOf(item.span.start, monday), minOf(item.span.end, sunday))
    if (inside <= 0) return Fraction.ZERO
    val estimate = if (item.estimateMd.scale() < 0) item.estimateMd.setScale(0) else item.estimateMd
    return Fraction.reduced(
        estimate.unscaledValue() * BigInteger.valueOf(inside),
        BigInteger.TEN.pow(estimate.scale()) * BigInteger.valueOf(total),
    )
}

/**
 * One [WeekLoad] per ISO week of [window] (from its first day's Monday to its last day's week; empty for null): the load is every
 * item's EXACT spread share summed as a fraction and rounded once, `HALF_UP`, to two decimals, the capacity [weekCapacity],
 * `overloaded` the comparison of the two rounded figures, and the WIP the per-working-day count against the limit in force that day.
 */
fun weeklyLoad(items: List<LoadItem>, periods: List<CapacityPeriod>, window: DaySpan?, calendar: WorkingCalendar): List<WeekLoad> {
    if (window == null) return emptyList()
    val effective = items.map { effectiveSpanOf(it.span, calendar) }
    val weeks = generateSequence(mondayOf(window.start)) { it.plusWeeks(1) }.takeWhile { !it.isAfter(window.end) }
    return weeks.map { monday -> weekRow(monday, items, effective, periods, calendar) }.toList()
}

private fun weekRow(
    monday: LocalDate,
    items: List<LoadItem>,
    effective: List<EffectiveSpan>,
    periods: List<CapacityPeriod>,
    calendar: WorkingCalendar,
): WeekLoad {
    val sunday = monday.plusDays(DAYS_PER_WEEK - 1)
    val exact = items.fold(Fraction.ZERO) { sum, item -> sum + shareIn(item, monday, sunday, calendar) }
    val load = BigDecimal(exact.num).divide(BigDecimal(exact.den), MONEY_SCALE, RoundingMode.HALF_UP)
    val capacity = weekCapacity(monday, periods, calendar)
    val overloaded = capacity != null && load > capacity
    val days = workingDaysOf(monday, calendar)
    val counts = days.map { it to wipAt(it, effective, calendar) }
    return WeekLoad(
        weekStart = monday,
        load = load,
        capacity = capacity,
        overloaded = overloaded,
        overloadMd = capacity?.takeIf { overloaded }?.let { load - it },
        maxWip = counts.maxOfOrNull { it.second } ?: 0,
        wipExceeded = counts.any { (day, count) -> wipLimitOn(day, periods)?.let { count > it } ?: false },
    )
}
