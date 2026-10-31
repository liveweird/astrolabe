package ch.nokillswit.planning

import kotlinx.serialization.Serializable
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/** An inclusive span of calendar days (`start <= end`): the neutral input and output of the span kernels. */
data class DaySpan(val start: LocalDate, val end: LocalDate)

/**
 * How far a derived span sits from a target window, in calendar days; POSITIVE = later than the target. [startDays] is
 * `span.start - target.start`, [endDays] is `span.end - target.end` (zero = on target, negative = ahead). The wire shape of the
 * project view's `drift`.
 */
@Serializable
data class Drift(val startDays: Long, val endDays: Long)

/**
 * The span kernels as pure functions (no I/O, no clock), the idiom of `CapacityKernels.kt`: a parent's real span is DERIVED from its
 * children at request time and never stored (`planning-model.md`). The project view derives a project's span from its scheduled
 * milestones; v0.6 reuses [derivedSpan] for programs (over their projects' spans) and the roadmap.
 */
object SpanKernels {
    /** The span from the earliest start to the latest end over [spans]; null when there are none (nothing scheduled). */
    fun derivedSpan(spans: Iterable<DaySpan>): DaySpan? {
        var start: LocalDate? = null
        var end: LocalDate? = null
        for (span in spans) {
            if (start == null || span.start < start) start = span.start
            if (end == null || span.end > end) end = span.end
        }
        return if (start != null && end != null) DaySpan(start, end) else null
    }

    /** The signed day deltas of [span] against [target]; null unless BOTH exist (with either missing there is nothing to drift from). */
    fun drift(span: DaySpan?, target: DaySpan?): Drift? {
        if (span == null || target == null) return null
        return Drift(
            startDays = ChronoUnit.DAYS.between(target.start, span.start),
            endDays = ChronoUnit.DAYS.between(target.end, span.end),
        )
    }
}
