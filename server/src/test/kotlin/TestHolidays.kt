package ch.nokillswit

import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.planning.PublicHolidayCreateRequest
import ch.nokillswit.planning.PublicHolidayService
import java.time.LocalDate

/**
 * The public-holiday dictionary (`public_holidays`, V19) from the test side. The table is GLOBAL, shared state and starts EMPTY (no
 * seed), so a test that needs a holiday on a particular day adds it for the duration of [with] and removes it in a `finally`; a test of
 * the dictionary itself owns far-off years (2085+). Both mutations are plan writes and bump the plan revision (harmless: a revision-
 * sensitive test reads the revision it needs).
 */
object TestHolidays {
    val service: PublicHolidayService by lazy { PublicHolidayService(sharedDatabaseForTests()) }

    /** Runs [block] with a holiday on [date] (ISO) and removes it afterwards. */
    suspend fun <T> with(date: String, name: String = "Test holiday", block: suspend () -> T): T {
        val created = service.create(PublicHolidayCreateRequest(date, name)).value
        return try {
            block()
        } finally {
            remove(created.id)
        }
    }

    /** Removes a holiday if it is still there (a `finally` cleanup: the test may already have deleted it through the API). */
    suspend fun remove(id: UInt) {
        try {
            service.delete(id)
        } catch (_: NotFoundException) {
            // already gone
        }
    }

    /** Every date the dictionary holds right now. */
    suspend fun dates(): Set<LocalDate> = service.list().map { LocalDate.parse(it.date) }.toSet()

    /** Removes every holiday of [year] (a test that applied a preset cleans up with it). */
    suspend fun clearYear(year: Int) {
        service.list().filter { LocalDate.parse(it.date).year == year }.forEach { remove(it.id) }
    }
}
