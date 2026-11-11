package ch.nokillswit

import ch.nokillswit.infra.json.sha256Hex
import ch.nokillswit.jira.fingerprintOf
import ch.nokillswit.planning.Deviation
import ch.nokillswit.planning.DeviationDetail
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.planning.DeviationSeverity
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/** The pure fingerprint of a deviation list: what an acknowledgement is keyed on. */
class DeviationFingerprintTest {
    private val end = Deviation(DeviationKind.END_DIFFERS, DeviationSeverity.WARNING, DeviationDetail("2044-02-04", "2044-02-09", 3, null))
    private val renamed = Deviation(DeviationKind.RENAMED, DeviationSeverity.INFO, DeviationDetail("Jira name", "Plan name", null, null))

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
    fun `a count enters the hash as a value, a null count does not, and a coverage list hashes to its own pinned digest`() {
        val unlinked = Deviation(DeviationKind.UNLINKED_IN_JIRA, DeviationSeverity.WARNING, DeviationDetail("COV-5", null, null, 1))
        val base = fingerprintOf(listOf(unlinked))
        assertNotEquals(base, fingerprintOf(listOf(unlinked.copy(detail = unlinked.detail.copy(count = 2)))))
        assertNotEquals(base, fingerprintOf(listOf(unlinked.copy(detail = unlinked.detail.copy(count = null)))))
        assertEquals(base, fingerprintOf(listOf(unlinked.copy())))
        // Canonical JSON of [{"detail":{"count":1,"jira":"COV-5"},"kind":"UNLINKED_IN_JIRA","severity":"WARNING"}], null members omitted.
        assertEquals("df05b300afe34e2a4284eaa8e16bfa0c7c7e2c7b2aa000618279c5b403407b94", base)
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

    @Test
    fun `one deviation hashes to its own pinned digest, severity included, and is not the list's of one`() {
        // Canonical JSON of {"detail":{"days":3,"jira":"2044-02-04","plan":"2044-02-09"},"kind":"END_DIFFERS","severity":"WARNING"}.
        // If this moves, every stored per-line acknowledgement reopens (1.12).
        assertEquals("3fa1415e313c08f1c25b36da203271e01a3e6346662a17e8779673800d267a3d", fingerprintOf(end))
        assertEquals("922be7cd9efb19c5328cee1d136bb7c7241ca7b25cf71deedc0e7846351a3ffb", fingerprintOf(renamed))
        assertNotEquals(fingerprintOf(end), fingerprintOf(listOf(end)), "an object is not an array of one")
        assertNotEquals(fingerprintOf(end), fingerprintOf(end.copy(severity = DeviationSeverity.INFO)), "the severity is part of a line")
        assertNotEquals(fingerprintOf(end), fingerprintOf(end.copy(detail = end.detail.copy(days = 4))))
        assertEquals(fingerprintOf(end), fingerprintOf(end.copy(detail = end.detail.copy())))
    }

    @Test
    fun `a coverage line pins its digest too - the count enters, a null count does not`() {
        val unlinked = Deviation(DeviationKind.UNLINKED_IN_JIRA, DeviationSeverity.WARNING, DeviationDetail("COV-5", null, null, 1))
        assertEquals("e48da6aa1cdd4ea24e2535cd503fab44e80eaeb95025c4edb11bbc474fa1434f", fingerprintOf(unlinked))
        assertNotEquals(fingerprintOf(unlinked), fingerprintOf(unlinked.copy(detail = unlinked.detail.copy(count = null))))
    }
}
