package ch.nokillswit

import ch.nokillswit.sync.SyncFirstTickDelayKey
import ch.nokillswit.sync.SyncScheduler
import ch.nokillswit.sync.SyncSchedulerKey
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `configureSync`'s boot (`sync/Sync.kt`): `sync.tickSeconds` is validated on EVERY boot (15..600), the scheduler flag is strict, a
 * disabled scheduler starts no loop, and an enabled one lives on the runner's scope so it is gone when the application has stopped.
 */
class SyncBootTest {
    // The enabled boots never reach their first tick, however slow the machine: no run is claimed in the shared database.
    private companion object {
        const val NEVER_TICKS = 3_600_000L
    }

    @Test
    fun `a tick outside 15 to 600 seconds, or one that is not a number, refuses to start naming its key`() {
        for (bad in listOf("14", "601", "0", "-60", "abc", "1.5")) {
            testApplication {
                configureApp("sync.tickSeconds" to bad)
                assertStartupFails("sync.tickSeconds") { startApplication() }
            }
        }
    }

    @Test
    fun `the bounds themselves start, with the scheduler off or on`() {
        for (tick in listOf("15", "600")) {
            for (enabled in listOf("false", "true")) {
                testApplication {
                    configureApp("sync.tickSeconds" to tick, "sync.scheduler.enabled" to enabled)
                    application { attributes.put(SyncFirstTickDelayKey, NEVER_TICKS) }
                    startApplication()
                }
            }
        }
    }

    @Test
    fun `the scheduler flag must be true or false`() {
        testApplication {
            configureApp("sync.scheduler.enabled" to "yes")
            assertStartupFails("sync.scheduler.enabled") { startApplication() }
        }
    }

    @Test
    fun `a disabled scheduler publishes nothing, which is the harness default`() = testApplication {
        configureApp()
        startApplication()
        assertNull(application.attributes.getOrNull(SyncSchedulerKey))
    }

    @Test
    fun `an enabled scheduler runs on the runner's scope and its loop is gone once the application has stopped`() {
        var scheduler: SyncScheduler? = null
        testApplication {
            configureApp("sync.scheduler.enabled" to "true")
            application { attributes.put(SyncFirstTickDelayKey, NEVER_TICKS) }
            startApplication()
            val started = assertNotNull(application.attributes.getOrNull(SyncSchedulerKey))
            assertTrue(assertNotNull(started.loop).isActive, "the loop is running while the application is")
            scheduler = started
        }
        assertTrue(assertNotNull(assertNotNull(scheduler).loop).isCompleted, "the application's stop ended the scheduler's loop")
    }
}
