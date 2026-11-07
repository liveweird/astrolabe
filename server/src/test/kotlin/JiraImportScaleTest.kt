package ch.nokillswit

import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The lock hold of the apply at scale, measured: a scripted Jira site (a Ktor MockEngine under the real client) answers a plan-sized scope
 * - 20 programs, 100 projects, 1,000 milestones, every milestone dated - and the apply writes it in ONE plan write. The timed span is
 * `JiraImportService.apply` from the lock request to the commit: exactly how long every other plan writer waits (the browse is outside
 * it). The figure is a `scale-figure` line ([ScaleFigures]) and is recorded in `build-times.md`; the bound asserted here is a loose
 * tripwire. The rows are removed in a `NonCancellable` `finally`.
 */
class JiraImportScaleTest {
    private suspend fun ApplicationTestBuilder.measure(label: String, programs: Int, projects: Int, milestones: Int) {
        val f = importFixture("jisc$label")
        val tag = planName("sc$label")
        try {
            val applied = applyScaleImport(f, tag, programs, projects, milestones)
            assertEquals(programs + projects + milestones, applied.created.result.created.size)
            assertEquals(applied.revisionBefore + 1, applied.created.result.revision)
            assertEquals(milestones, applied.created.result.created.count { it.scheduled })
            ScaleFigures.print("jira-import apply $label ($programs/$projects/$milestones)", applied.millis)
            assertTrue(applied.millis <= TRIPWIRE_MS, "the apply held the plan lock for ${applied.millis} ms")
        } finally {
            // NonCancellable: a test cancelled by the 60 s limit must still take its thousands of rows out of the shared plan.
            withContext(NonCancellable) { removeScaleRows(f.connectionId, tag) }
        }
    }

    @Test
    fun `the plan-sized import - 20 programs, 100 projects, 1,000 milestones - holds the lock for seconds at most`() = testApplication {
        measure("plan", 20, 100, 1_000)
    }

    @Test
    fun `an import at the 2,000-item cap holds the plan lock for seconds at most`() = testApplication {
        measure("cap", 20, 100, 1_880)
    }

    companion object {
        /** Loose: at least 5x the figure measured on the dev machine (about 1 s and 2 s), so a slower runner never flakes it. */
        private const val TRIPWIRE_MS = 10_000.0

        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
