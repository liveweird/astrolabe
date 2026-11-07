package ch.nokillswit

import ch.nokillswit.infra.json.sha256Hex
import ch.nokillswit.jira.Deviation
import ch.nokillswit.jira.DeviationDetail
import ch.nokillswit.jira.DeviationKind
import ch.nokillswit.jira.DeviationSeverity
import ch.nokillswit.jira.fingerprintOf
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/** The pure fingerprint of a deviation list: what an acknowledgement is keyed on. */
class DeviationFingerprintTest {
    private val end = Deviation(DeviationKind.END_DIFFERS, DeviationSeverity.WARNING, DeviationDetail("2044-02-04", "2044-02-09", 3))
    private val renamed = Deviation(DeviationKind.RENAMED, DeviationSeverity.INFO, DeviationDetail("Jira name", "Plan name", null))

    @Test
    fun `it is 64 lower-case hex and equal for equal lists whatever the instance`() {
        val one = fingerprintOf(listOf(end, renamed))
        assertTrue(Regex("^[0-9a-f]{64}$").matches(one))
        assertEquals(one, fingerprintOf(listOf(end.copy(), renamed.copy(detail = renamed.detail.copy()))))
    }

    @Test
    fun `any change to a kind, a severity, a detail member or the order changes it`() {
        val base = fingerprintOf(listOf(end, renamed))
        assertNotEquals(base, fingerprintOf(listOf(end, renamed.copy(kind = DeviationKind.RENAMED, severity = DeviationSeverity.WARNING))))
        assertNotEquals(base, fingerprintOf(listOf(end.copy(detail = end.detail.copy(days = 4)), renamed)))
        assertNotEquals(base, fingerprintOf(listOf(end.copy(detail = end.detail.copy(plan = "2044-02-10")), renamed)))
        assertNotEquals(base, fingerprintOf(listOf(end.copy(kind = DeviationKind.START_DIFFERS), renamed)))
        assertNotEquals(base, fingerprintOf(listOf(renamed, end)), "the kernel's order is part of the list")
        assertNotEquals(base, fingerprintOf(listOf(end)))
    }

    @Test
    fun `a two-element list hashes to a pinned digest - nulls are not written, so an added nullable member moves nothing`() {
        // Canonical JSON, keys sorted, null `days` of the second element omitted. If this moves, every stored acknowledgement reopens.
        assertEquals("de7a297315337783a03217885215208eec0ccfcdf972a89bdc8b44f3f3a5b861", fingerprintOf(listOf(end, renamed)))
    }

    @Test
    fun `a null member is not an absent one and the empty list hashes the empty array`() {
        assertEquals(sha256Hex("[]"), fingerprintOf(emptyList()))
        assertNotEquals(
            fingerprintOf(listOf(renamed)),
            fingerprintOf(listOf(renamed.copy(detail = renamed.detail.copy(days = 0)))),
            "null days differ from zero days",
        )
        assertNotEquals(
            fingerprintOf(listOf(renamed)),
            fingerprintOf(listOf(renamed.copy(detail = renamed.detail.copy(jira = null)))),
            "a missing value differs from a present one",
        )
    }
}
