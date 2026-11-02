package ch.nokillswit

import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.BaselineKernels
import ch.nokillswit.planning.DaySpan
import ch.nokillswit.planning.FrozenMilestone
import ch.nokillswit.planning.LiveMilestone
import ch.nokillswit.planning.Movement
import ch.nokillswit.planning.MovementKind
import ch.nokillswit.planning.MovementTotals
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * The pure baseline comparison (no server, no database). Every vector is hand-counted on 2027-02 (the 1st is a Monday): Mon-Fri
 * working index W(02-01)=1, 02-02=2, 02-03=3, 02-04=4, 02-05=5, 02-08=6 ... 02-12=10, and 01-25..29 = -4..0; a Wed 02-03 holiday
 * collapses 02-03 onto 02-02 and shifts every later day down by one.
 */
class BaselineKernelsTest {
    private fun date(value: String) = LocalDate.parse(value)

    private fun span(start: String, end: String) = DaySpan(date(start), date(end))

    private val monFri = WorkingCalendar.MON_FRI
    private val wednesdayOff = WorkingCalendar(mapOf(date("2027-02-03") to "Test day"))

    private fun frozen(span: DaySpan?, estimate: String = "10") =
        FrozenMilestone(1u, 7u, 3u, "Rollout", BigDecimal(estimate), span)

    private fun live(span: DaySpan?, estimate: String = "10") =
        LiveMilestone(1u, 7u, 3u, "Rollout", BigDecimal(estimate), span)

    private fun movement(from: DaySpan?, to: DaySpan?, calendar: WorkingCalendar = monFri) =
        BaselineKernels.milestoneMovement(frozen(from), live(to), calendar)

    private val week = span("2027-02-01", "2027-02-05")

    @Test
    fun `two dated spans give start and end deltas in working days`() {
        val cases = listOf(
            "a week later" to (span("2027-02-08", "2027-02-12") to Movement(MovementKind.MOVED, 5, 5, BigDecimal.ZERO)),
            "a week earlier" to (span("2027-01-25", "2027-01-29") to Movement(MovementKind.MOVED, -5, -5, BigDecimal.ZERO)),
            "only the end later" to (span("2027-02-01", "2027-02-08") to Movement(MovementKind.MOVED, 0, 1, BigDecimal.ZERO)),
            "only the start later" to (span("2027-02-02", "2027-02-05") to Movement(MovementKind.MOVED, 1, 0, BigDecimal.ZERO)),
            "a Saturday start is its Monday" to
                (span("2027-01-30", "2027-02-05") to Movement(MovementKind.UNCHANGED, 0, 0, BigDecimal.ZERO)),
            "a Saturday end is its Friday" to
                (span("2027-02-01", "2027-02-06") to Movement(MovementKind.UNCHANGED, 0, 0, BigDecimal.ZERO)),
            "identical" to (week to Movement(MovementKind.UNCHANGED, 0, 0, BigDecimal.ZERO)),
        )
        for ((label, case) in cases) assertEquals(case.second, movement(week, case.first), label)
    }

    @Test
    fun `a holiday on the current calendar shortens the count`() {
        // W: 02-01=1, 02-02=2, (02-03 off), 02-04=3, 02-05=4, 02-08=5, 02-12=9 -> start +4, end +5.
        assertEquals(Movement(MovementKind.MOVED, 4, 5, BigDecimal.ZERO), movement(week, span("2027-02-08", "2027-02-12"), wednesdayOff))
        // The same move without the holiday is +5, +5.
        assertEquals(Movement(MovementKind.MOVED, 5, 5, BigDecimal.ZERO), movement(week, span("2027-02-08", "2027-02-12")))
    }

    @Test
    fun `a start or an end on an off day snaps to the working day beside it`() {
        val mondayOff = WorkingCalendar(mapOf(date("2027-02-01") to "Test day"))
        // Monday 02-01 is off: the frozen start snaps forward to Tuesday 02-02, so Tuesday is no movement.
        assertEquals(
            Movement(MovementKind.UNCHANGED, 0, 0, BigDecimal.ZERO),
            movement(week, span("2027-02-02", "2027-02-05"), mondayOff),
        )
        val fridayOff = WorkingCalendar(mapOf(date("2027-02-05") to "Test day"))
        // Friday 02-05 is off: the frozen end snaps back to Thursday 02-04, so ending Thursday is no movement.
        assertEquals(
            Movement(MovementKind.UNCHANGED, 0, 0, BigDecimal.ZERO),
            movement(week, span("2027-02-01", "2027-02-04"), fridayOff),
        )
    }

    @Test
    fun `scheduled, unscheduled and never scheduled`() {
        assertEquals(Movement(MovementKind.SCHEDULED, null, null, BigDecimal.ZERO), movement(null, week))
        assertEquals(Movement(MovementKind.UNSCHEDULED, null, null, BigDecimal.ZERO), movement(week, null))
        assertEquals(Movement(MovementKind.UNCHANGED, null, null, BigDecimal.ZERO), movement(null, null))
    }

    @Test
    fun `a row on one side only is added or removed with no deltas`() {
        assertEquals(Movement(MovementKind.ADDED, null, null, null), BaselineKernels.milestoneMovement(null, live(week), monFri))
        assertEquals(Movement(MovementKind.REMOVED, null, null, null), BaselineKernels.milestoneMovement(frozen(week), null, monFri))
        assertFailsWith<IllegalArgumentException> { BaselineKernels.milestoneMovement(null, null, monFri) }
    }

    @Test
    fun `an estimate change alone is a delta on an unchanged row`() {
        val moved = BaselineKernels.milestoneMovement(frozen(week, "10"), live(week, "12.5"), monFri)
        assertEquals(Movement(MovementKind.UNCHANGED, 0, 0, BigDecimal("2.5")), moved)
        val shrunk = BaselineKernels.milestoneMovement(frozen(week, "10"), live(week, "8"), monFri)
        assertEquals(BigDecimal("-2"), shrunk.estimateDelta)
        // The delta rides along on a flip too.
        assertEquals(BigDecimal("2.5"), BaselineKernels.milestoneMovement(frozen(null, "10"), live(week, "12.5"), monFri).estimateDelta)
    }

    @Test
    fun `span movement follows the same table with no estimate`() {
        val nextWeek = span("2027-02-08", "2027-02-12")
        assertEquals(Movement(MovementKind.MOVED, 5, 5, null), BaselineKernels.spanMovement(week, nextWeek, monFri))
        assertEquals(Movement(MovementKind.MOVED, 4, 5, null), BaselineKernels.spanMovement(week, nextWeek, wednesdayOff))
        val saturdayStart = span("2027-01-30", "2027-02-05")
        assertEquals(Movement(MovementKind.UNCHANGED, 0, 0, null), BaselineKernels.spanMovement(week, saturdayStart, monFri))
        assertEquals(Movement(MovementKind.SCHEDULED, null, null, null), BaselineKernels.spanMovement(null, week, monFri))
        assertEquals(Movement(MovementKind.UNSCHEDULED, null, null, null), BaselineKernels.spanMovement(week, null, monFri))
        assertEquals(Movement(MovementKind.UNCHANGED, null, null, null), BaselineKernels.spanMovement(null, null, monFri))
    }

    @Test
    fun `totals count the kinds and split moved rows by their end`() {
        val movements = listOf(
            movement(week, span("2027-02-08", "2027-02-12")), // moved, later
            movement(week, span("2027-02-01", "2027-02-08")), // moved, later (end only)
            movement(week, span("2027-01-25", "2027-01-29")), // moved, earlier
            movement(week, span("2027-02-02", "2027-02-05")), // moved, start only: neither
            movement(week, week), // unchanged
            movement(null, null), // unchanged
            movement(null, week), // scheduled
            movement(week, null), // unscheduled
            BaselineKernels.milestoneMovement(null, live(week), monFri), // added
            BaselineKernels.milestoneMovement(frozen(week), null, monFri), // removed
            BaselineKernels.milestoneMovement(frozen(week), null, monFri), // removed
        )
        assertEquals(
            MovementTotals(unchanged = 2, moved = 4, later = 2, earlier = 1, scheduled = 1, unscheduled = 1, added = 1, removed = 2),
            BaselineKernels.totals(movements),
        )
        assertEquals(MovementTotals(0, 0, 0, 0, 0, 0, 0, 0), BaselineKernels.totals(emptyList()))
    }
}
