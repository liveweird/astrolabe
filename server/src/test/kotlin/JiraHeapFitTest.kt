package ch.nokillswit

import ch.nokillswit.jira.availableOldGenerationBytes
import ch.nokillswit.jira.jiraHeapVerdict
import ch.nokillswit.jira.requireHeapFitsJiraCeilings
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The boot-time heap fit (`jira/JiraHeapFit.kt`): the shipped defaults fit the shipped JVM, a raised ceiling without heap is refused. */
class JiraHeapFitTest {
    private val mib = 1024L * 1024

    /** `-Xmx256m -Xmn64m` (`server/build.gradle.kts`): the old generation is the 192 MiB left after the young one. */
    private val shippedOldGeneration = 192 * mib

    @Test
    fun `the default configuration fits the shipped heap`() {
        // 4 MiB cap: one 56 MiB tree + one 14 MiB small tree + 2 x 4 MiB bodies + the 96 MiB reserve.
        val verdict = jiraHeapVerdict(maxResponseBytes = 4_194_304, maxConcurrentRequests = 2, availableBytes = shippedOldGeneration)
        assertEquals((56 + 14 + 8 + 96) * mib, verdict.needBytes)
        assertTrue(verdict.fits)
        requireHeapFitsJiraCeilings(4_194_304, 2, shippedOldGeneration)
    }

    @Test
    fun `the largest ceilings do not fit it, and the refusal names the knobs and the figures`() {
        assertFalse(jiraHeapVerdict(16L * 1024 * 1024, 8, shippedOldGeneration).fits)
        val failure = assertFailsWith<IllegalStateException> { requireHeapFitsJiraCeilings(16L * 1024 * 1024, 8, shippedOldGeneration) }
        val message = failure.message.orEmpty()
        assertTrue("jira.maxResponseBytes" in message && "jira.maxConcurrentRequests" in message && "-Xmx" in message, message)
        assertTrue("192 MiB" in message, message)
    }

    @Test
    fun `a larger cap alone is refused too, and the need grows with both knobs`() {
        assertFalse(jiraHeapVerdict(12L * 1024 * 1024, 2, shippedOldGeneration).fits)
        val base = jiraHeapVerdict(4_194_304, 2, 0).needBytes
        assertTrue(jiraHeapVerdict(4_194_304, 3, 0).needBytes > base)
        assertTrue(jiraHeapVerdict(8_388_608, 2, 0).needBytes > base)
    }

    @Test
    fun `the running JVM reports an old generation, and the defaults fit it`() {
        val available = availableOldGenerationBytes()
        assertTrue(available > 0)
        // The test JVM is not the shipped one; it must still hold the defaults or `configureJira` could not boot in any other test.
        requireHeapFitsJiraCeilings(4_194_304, 2, available)
    }
}
