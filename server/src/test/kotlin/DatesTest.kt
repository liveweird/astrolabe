package ch.nokillswit

import ch.nokillswit.infra.validation.parseIsoDate
import ch.nokillswit.infra.validation.requireDateOrder
import io.ktor.server.plugins.BadRequestException
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/** Pure unit tests for the wire-date helpers (`infra/validation/Dates.kt`). */
class DatesTest {

    @Test
    fun `parseIsoDate accepts a plain ISO calendar date, leap day included`() {
        assertEquals(LocalDate.of(2026, 10, 25), parseIsoDate("2026-10-25", "Start date"))
        assertEquals(LocalDate.of(2028, 2, 29), parseIsoDate("2028-02-29", "Start date"))
        assertEquals(LocalDate.of(1970, 1, 1), parseIsoDate("1970-01-01", "Start date"))
        assertEquals(LocalDate.of(1900, 1, 1), parseIsoDate("1900-01-01", "Start date"))
        assertEquals(LocalDate.of(2999, 12, 31), parseIsoDate("2999-12-31", "Start date"))
    }

    @Test
    fun `parseIsoDate rejects every other shape with a message naming the field`() {
        val bad = listOf(
            "", " ", "2026-1-5", "26-10-25", "2026/10/25", "20261025", "2026-10-25T00:00:00Z", "2026-10-25 ",
            " 2026-10-25", "+2026-10-25", "-0001-10-25", "２０２６-10-25", "2026-10-25\n",
        )
        for (value in bad) {
            val failure = assertFailsWith<BadRequestException>("'$value' must be refused") { parseIsoDate(value, "Start date") }
            assertEquals("Start date must be a YYYY-MM-DD date", failure.message)
        }
    }

    @Test
    fun `parseIsoDate rejects a day that is not on the calendar`() {
        for (value in listOf("2026-02-30", "2026-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-01-00")) {
            assertFailsWith<BadRequestException>("'$value' must be refused") { parseIsoDate(value, "End date") }
        }
    }

    @Test
    fun `parseIsoDate rejects a year outside 1900-2999`() {
        for (value in listOf("1899-12-31", "1500-01-01", "0100-02-27", "0000-01-01", "3000-01-01", "9999-12-31")) {
            val failure = assertFailsWith<BadRequestException>("'$value' must be refused") { parseIsoDate(value, "Start date") }
            assertEquals("Start date year must be between 1900 and 2999", failure.message)
        }
    }

    @Test
    fun `requireDateOrder allows equal and ascending dates and rejects an end before the start`() {
        val day = LocalDate.of(2026, 3, 29)
        requireDateOrder(day, day)
        requireDateOrder(day, day.plusDays(1))
        val failure = assertFailsWith<BadRequestException> { requireDateOrder(day, day.minusDays(1)) }
        assertEquals("End must not be before start", failure.message)
    }
}
