package ch.nokillswit

import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.Drift
import ch.nokillswit.planning.SpanKernels
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The pure span kernels (no server, no database): table-driven. */
class SpanKernelsTest {
    private fun span(start: String, end: String) = DaySpan(LocalDate.parse(start), LocalDate.parse(end))

    @Test
    fun `the derived span runs from the earliest start to the latest end`() {
        val cases = listOf(
            "none" to (emptyList<DaySpan>() to null),
            "one span is itself" to (listOf(span("2026-11-02", "2026-11-13")) to span("2026-11-02", "2026-11-13")),
            "one day" to (listOf(span("2026-11-03", "2026-11-03")) to span("2026-11-03", "2026-11-03")),
            "disjoint spans leave the gap inside" to
                (listOf(span("2026-11-02", "2026-11-04"), span("2026-12-01", "2026-12-04")) to span("2026-11-02", "2026-12-04")),
            "the earliest start and the latest end come from different spans" to
                (listOf(span("2026-11-10", "2026-12-31"), span("2026-11-02", "2026-11-05")) to span("2026-11-02", "2026-12-31")),
            "a span nested in another changes nothing" to
                (listOf(span("2026-11-02", "2026-12-31"), span("2026-11-10", "2026-11-12")) to span("2026-11-02", "2026-12-31")),
            "order does not matter" to
                (listOf(span("2026-12-01", "2026-12-04"), span("2026-11-02", "2026-11-04")) to span("2026-11-02", "2026-12-04")),
            "across a year boundary" to
                (listOf(span("2026-12-28", "2027-01-08"), span("2026-12-01", "2026-12-05")) to span("2026-12-01", "2027-01-08")),
        )
        for ((label, case) in cases) assertEquals(case.second, SpanKernels.derivedSpan(case.first), label)
    }

    @Test
    fun `drift is the signed day delta of the span against the target - positive is later`() {
        val target = span("2026-11-02", "2026-11-30")
        val cases = listOf(
            "on target" to (span("2026-11-02", "2026-11-30") to Drift(0, 0)),
            "ends 12 days late" to (span("2026-11-02", "2026-12-12") to Drift(0, 12)),
            "ahead by 3 days at both ends" to (span("2026-10-30", "2026-11-27") to Drift(-3, -3)),
            "starts late and ends early" to (span("2026-11-09", "2026-11-23") to Drift(7, -7)),
            "across a leap day (2028-02-29 counts)" to (span("2028-03-01", "2028-03-01") to Drift(485, 457)),
        )
        for ((label, case) in cases) assertEquals(case.second, SpanKernels.drift(case.first, target), label)
    }

    @Test
    fun `drift is null unless both the span and the target exist`() {
        assertNull(SpanKernels.drift(null, null))
        assertNull(SpanKernels.drift(null, span("2026-11-02", "2026-11-30")), "nothing scheduled")
        assertNull(SpanKernels.drift(span("2026-11-02", "2026-11-30"), null), "no target window")
    }
}
