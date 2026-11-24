package ch.nokillswit

import ch.nokillswit.planning.BaselineCapacityKernels
import ch.nokillswit.planning.CapacityChange
import ch.nokillswit.planning.CapacityFigure
import ch.nokillswit.planning.CapacityPeriod
import ch.nokillswit.planning.CapacityRange
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The pure capacity comparison (no server, no database). A period holds from its start to the day before the next one's, the last one
 * without end, and before the first there is NO capacity (null, not zero). Every vector is hand-counted on 2027 (not a leap year:
 * February has 28 days, so the day before 03-01 is 02-28).
 */
class BaselineCapacityKernelsTest {
    private fun date(value: String) = LocalDate.parse(value)

    private fun period(from: String, md: String, wip: Int? = null) = CapacityPeriod(date(from), BigDecimal(md), wip)

    private fun figure(md: String, wip: Int? = null) = CapacityFigure(BigDecimal(md), wip)

    private fun change(from: String, to: String?, then: CapacityFigure?, now: CapacityFigure?) =
        CapacityChange(date(from), to?.let(::date), then, now)

    /** The figures compare by value (10 and 10.00 are one figure), which a data class's `equals` does not: compare field by field. */
    private fun assertChanges(expected: List<CapacityChange>, actual: List<CapacityChange>) {
        assertEquals(expected.size, actual.size, "number of ranges: $actual")
        expected.zip(actual).forEach { (e, a) ->
            assertEquals(e.from to e.to, a.from to a.to)
            for ((x, y) in listOf(e.then to a.then, e.now to a.now)) {
                assertEquals(x == null, y == null, "presence of a figure in $a")
                if (x != null && y != null) assertEquals(true, x.sameAs(y), "$x vs $y")
            }
        }
    }

    @Test
    fun `equal capacity is no change, however the periods are split or written`() {
        assertChanges(emptyList(), BaselineCapacityKernels.changes(emptyList(), emptyList()))
        val same = listOf(period("2027-01-01", "10", 3))
        assertChanges(emptyList(), BaselineCapacityKernels.changes(same, same.toList()))
        // A period split in two equal ones, and 10 written as 10.00.
        val split = listOf(period("2027-01-01", "10.00", 3), period("2027-02-01", "10", 3), period("2027-03-01", "10.0", 3))
        assertChanges(emptyList(), BaselineCapacityKernels.changes(listOf(period("2027-01-01", "10", 3)), split))
        assertChanges(emptyList(), BaselineCapacityKernels.changes(split, listOf(period("2027-01-01", "10", 3))))
    }

    @Test
    fun `a figure that differs from its start without end is one open range`() {
        // 10 -> 8 from the same day on; only the WIP limit changing is a change too (null -> 5).
        assertChanges(
            listOf(change("2027-01-01", null, figure("10"), figure("8"))),
            BaselineCapacityKernels.changes(listOf(period("2027-01-01", "10")), listOf(period("2027-01-01", "8"))),
        )
        assertChanges(
            listOf(change("2027-01-01", null, figure("10"), figure("10", 5))),
            BaselineCapacityKernels.changes(listOf(period("2027-01-01", "10")), listOf(period("2027-01-01", "10", 5))),
        )
        // A cut from 02-01: same until then.
        assertChanges(
            listOf(change("2027-02-01", null, figure("10"), figure("6"))),
            BaselineCapacityKernels.changes(
                listOf(period("2027-01-01", "10")),
                listOf(period("2027-01-01", "10"), period("2027-02-01", "6")),
            ),
        )
    }

    @Test
    fun `a dip in the middle is a bounded range ending the day before the figures meet again`() {
        val now = listOf(period("2027-01-01", "10"), period("2027-02-01", "6"), period("2027-03-01", "10"))
        assertChanges(
            listOf(change("2027-02-01", "2027-02-28", figure("10"), figure("6"))),
            BaselineCapacityKernels.changes(listOf(period("2027-01-01", "10")), now),
        )
        // The mirror image: the baseline had the dip.
        assertChanges(
            listOf(change("2027-02-01", "2027-02-28", figure("6"), figure("10"))),
            BaselineCapacityKernels.changes(now, listOf(period("2027-01-01", "10"))),
        )
    }

    @Test
    fun `no capacity in force is a figure of its own, before the first period and when a side has none`() {
        // Now starts a month later: 01-01..01-31 had 10, has nothing.
        assertChanges(
            listOf(change("2027-01-01", "2027-01-31", figure("10"), null)),
            BaselineCapacityKernels.changes(listOf(period("2027-01-01", "10")), listOf(period("2027-02-01", "10"))),
        )
        // The baseline starts two weeks later: 01-01..01-14 has 10 now, had nothing.
        assertChanges(
            listOf(change("2027-01-01", "2027-01-14", null, figure("10"))),
            BaselineCapacityKernels.changes(listOf(period("2027-01-15", "10")), listOf(period("2027-01-01", "10"))),
        )
        // Nothing then, a period now (and the reverse): the whole open range.
        assertChanges(
            listOf(change("2027-01-01", null, null, figure("10", 2))),
            BaselineCapacityKernels.changes(emptyList(), listOf(period("2027-01-01", "10", 2))),
        )
        assertChanges(
            listOf(change("2027-01-01", null, figure("10", 2), null)),
            BaselineCapacityKernels.changes(listOf(period("2027-01-01", "10", 2)), emptyList()),
        )
        // Zero is a figure, not "none": 0 against nothing differs, 0 against 0 does not.
        assertChanges(
            listOf(change("2027-01-01", null, figure("0"), null)),
            BaselineCapacityKernels.changes(listOf(period("2027-01-01", "0")), emptyList()),
        )
        assertChanges(emptyList(), BaselineCapacityKernels.changes(listOf(period("2027-01-01", "0")), listOf(period("2027-01-01", "0.00"))))
    }

    @Test
    fun `adjacent segments with the same pair of figures are one range, with a different pair two`() {
        // then 10 all year; now 8 split at 02-01 and 03-01 -> one range from 01-01 without end.
        val split = listOf(period("2027-01-01", "8"), period("2027-02-01", "8"), period("2027-03-01", "8"))
        assertChanges(
            listOf(change("2027-01-01", null, figure("10"), figure("8"))),
            BaselineCapacityKernels.changes(listOf(period("2027-01-01", "10")), split),
        )
        // then 10 then 12 from 02-01; now 8 throughout: (10 -> 8) to 01-31, then (12 -> 8) without end.
        assertChanges(
            listOf(
                change("2027-01-01", "2027-01-31", figure("10"), figure("8")),
                change("2027-02-01", null, figure("12"), figure("8")),
            ),
            BaselineCapacityKernels.changes(
                listOf(period("2027-01-01", "10"), period("2027-02-01", "12")),
                listOf(period("2027-01-01", "8")),
            ),
        )
        // A change that stops and starts again: equal on 02-01..02-28 between two differing stretches -> two ranges, not one.
        assertChanges(
            listOf(
                change("2027-01-01", "2027-01-31", figure("10"), figure("8")),
                change("2027-03-01", null, figure("10"), figure("8")),
            ),
            BaselineCapacityKernels.changes(
                listOf(period("2027-01-01", "10")),
                listOf(period("2027-01-01", "8"), period("2027-02-01", "10"), period("2027-03-01", "8")),
            ),
        )
    }

    @Test
    fun `the unsorted input is read in date order`() {
        assertChanges(
            listOf(change("2027-02-01", null, figure("10"), figure("6"))),
            BaselineCapacityKernels.changes(
                listOf(period("2027-01-01", "10")),
                listOf(period("2027-02-01", "6"), period("2027-01-01", "10")),
            ),
        )
    }

    @Test
    fun `ranges run from each period to the day before the next, the last without end`() {
        val ranges = BaselineCapacityKernels.ranges(listOf(period("2027-03-01", "12", 4), period("2027-01-01", "10")))
        assertEquals(
            listOf(
                CapacityRange(date("2027-01-01"), date("2027-02-28"), figure("10")),
                CapacityRange(date("2027-03-01"), null, figure("12", 4)),
            ),
            ranges,
        )
        assertEquals(emptyList(), BaselineCapacityKernels.ranges(emptyList()))
    }
}
