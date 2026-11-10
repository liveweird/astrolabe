package ch.nokillswit

import ch.nokillswit.flow.CapacityDeviationDetail
import ch.nokillswit.flow.CapacityDeviationKind
import ch.nokillswit.flow.capacityFingerprint
import ch.nokillswit.planning.DeviationSeverity
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/** The pure fingerprint of one capacity deviation row (1.9): what a per-sprint acknowledgement is keyed on. */
class CapacityDeviationFingerprintTest {
    /** The stub's second sprint on day two: the plan has 36.00 against Flow's 30.00 over ten working days. */
    private val detail = CapacityDeviationDetail(
        sprintId = 90_002, sprintName = "E2E Flow Sprint 2", start = "2047-01-21", end = "2047-02-01", effectiveFrom = "2047-01-21",
        workingDays = 10, flowMd = 30.0, flowTotalMd = 30.0, planMd = 36.0, gapMd = 6.0,
    )
    private val gone = CapacityDeviationDetail(null, null, null, null, null, null, null, null, null, null)

    private fun of(d: CapacityDeviationDetail, kind: CapacityDeviationKind = CapacityDeviationKind.CAPACITY_DIFFERS) =
        capacityFingerprint(kind, DeviationSeverity.WARNING, d)

    @Test
    fun `it is 64 lower-case hex and equal for equal rows whatever the instance`() {
        val one = of(detail)
        assertTrue(Regex("^[0-9a-f]{64}$").matches(one))
        assertEquals(one, of(detail.copy()))
    }

    @Test
    fun `two rows differing only by the sprint name share a fingerprint - a rename in Flow reopens nothing`() {
        assertEquals(of(detail), of(detail.copy(sprintName = "Renamed in Flow")))
        assertEquals(of(detail), of(detail.copy(sprintName = null)))
    }

    @Test
    fun `a changed figure, date, held day count, working day count or severity changes it`() {
        val base = of(detail)
        assertNotEquals(base, of(detail.copy(planMd = 35.0)))
        assertNotEquals(base, of(detail.copy(flowMd = 29.0)))
        assertNotEquals(base, of(detail.copy(flowTotalMd = 31.0)))
        assertNotEquals(base, of(detail.copy(gapMd = 5.0)))
        assertNotEquals(base, of(detail.copy(end = "2047-02-02")))
        assertNotEquals(base, of(detail.copy(start = "2047-01-20")))
        assertNotEquals(base, of(detail.copy(effectiveFrom = "2047-01-22")))
        assertNotEquals(base, of(detail.copy(workingDays = 9)))
        assertNotEquals(base, of(detail.copy(sprintId = 90_003)))
        assertNotEquals(base, capacityFingerprint(CapacityDeviationKind.CAPACITY_DIFFERS, DeviationSeverity.INFO, detail))
        assertNotEquals(base, of(detail, CapacityDeviationKind.CAPACITY_MISSING))
        assertNotEquals(base, of(detail.copy(planMd = null, gapMd = null)), "a missing plan figure differs from a present one")
    }

    @Test
    fun `TEAM_GONE has one, with every detail member null`() {
        val fingerprint = of(gone, CapacityDeviationKind.TEAM_GONE)
        assertTrue(Regex("^[0-9a-f]{64}$").matches(fingerprint))
        assertNotEquals(fingerprint, of(detail, CapacityDeviationKind.TEAM_GONE))
    }

    @Test
    fun `a row hashes to a pinned digest - nulls are not written and the name is not an input`() {
        // Canonical JSON, keys sorted, the name omitted:
        // {"detail":{"effectiveFrom":"2047-01-21","end":"2047-02-01","flowMd":30.0,"flowTotalMd":30.0,"gapMd":6.0,"planMd":36.0,
        //  "sprintId":90002,"start":"2047-01-21","workingDays":10},"kind":"CAPACITY_DIFFERS","severity":"WARNING"}
        // If this moves, every stored capacity acknowledgement reopens.
        assertEquals("33b5b430352261ab16e48266b2c54a7de10482ed358ad439ac52a1a86d087aec", of(detail))
        // {"detail":{},"kind":"TEAM_GONE","severity":"WARNING"}
        assertEquals("9dcabbf51af3fecc29a277d4575113cb8ec05961ab8963bc3c11b1cd765d240e", of(gone, CapacityDeviationKind.TEAM_GONE))
    }
}
