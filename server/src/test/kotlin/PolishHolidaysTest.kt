package ch.nokillswit

import ch.nokillswit.planning.PolishHolidays
import java.time.DayOfWeek
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The Polish preset's generator against Flow's V25 literal rows (`~/Sources/flow/.../V25__public_holidays.sql`, 2017-2030): the
 * movable feasts (Easter Sunday, Pentecost = Easter + 49, Corpus Christi = Easter + 60) as typed in that migration, so a wrong Easter
 * cannot hide in the algorithm. Pure: no database.
 */
class PolishHolidaysTest {
    /** `year -> (Easter, Pentecost, Corpus Christi)` exactly as Flow's V25 lists them. */
    private val flowLiterals = mapOf(
        2017 to Triple("2017-04-16", "2017-06-04", "2017-06-15"),
        2018 to Triple("2018-04-01", "2018-05-20", "2018-05-31"),
        2019 to Triple("2019-04-21", "2019-06-09", "2019-06-20"),
        2020 to Triple("2020-04-12", "2020-05-31", "2020-06-11"),
        2021 to Triple("2021-04-04", "2021-05-23", "2021-06-03"),
        2022 to Triple("2022-04-17", "2022-06-05", "2022-06-16"),
        2023 to Triple("2023-04-09", "2023-05-28", "2023-06-08"),
        2024 to Triple("2024-03-31", "2024-05-19", "2024-05-30"),
        2025 to Triple("2025-04-20", "2025-06-08", "2025-06-19"),
        2026 to Triple("2026-04-05", "2026-05-24", "2026-06-04"),
        2027 to Triple("2027-03-28", "2027-05-16", "2027-05-27"),
        2028 to Triple("2028-04-16", "2028-06-04", "2028-06-15"),
        2029 to Triple("2029-04-01", "2029-05-20", "2029-05-31"),
        2030 to Triple("2030-04-21", "2030-06-09", "2030-06-20"),
    )

    private fun namedDate(year: Int, name: String): LocalDate = PolishHolidays.of(year).single { it.second == name }.first

    @Test
    fun `Easter, Pentecost and Corpus Christi equal Flow's V25 literals for 2017 to 2030`() {
        for ((year, expected) in flowLiterals) {
            assertEquals(LocalDate.parse(expected.first), PolishHolidays.easter(year), "Easter $year")
            assertEquals(LocalDate.parse(expected.first), namedDate(year, "Wielkanoc"), "Wielkanoc $year")
            assertEquals(LocalDate.parse(expected.second), namedDate(year, "Zielone Świątki"), "Pentecost $year")
            assertEquals(LocalDate.parse(expected.third), namedDate(year, "Boże Ciało"), "Corpus Christi $year")
        }
        assertEquals(14, flowLiterals.size)
    }

    @Test
    fun `Easter Sunday is a Sunday and the algorithm holds at the ends of the accepted range`() {
        for (year in 1900..2999) assertEquals(DayOfWeek.SUNDAY, PolishHolidays.easter(year).dayOfWeek, "Easter $year")
        assertEquals(LocalDate.of(1900, 4, 15), PolishHolidays.easter(1900))
        assertEquals(LocalDate.of(2038, 4, 25), PolishHolidays.easter(2038), "the latest Easter of the century")
    }

    @Test
    fun `a year holds 13 days, 14 from 2025 when Christmas Eve became statutory, all distinct and in date order`() {
        for (year in 1900..2999) {
            val holidays = PolishHolidays.of(year)
            assertEquals(if (year >= 2025) 14 else 13, holidays.size, "count in $year")
            assertEquals(holidays.size, holidays.map { it.first }.toSet().size, "distinct dates in $year")
            assertEquals(holidays.sortedBy { it.first }, holidays, "date order in $year")
            assertTrue(holidays.all { it.first.year == year }, "every day lies in $year")
            assertTrue(holidays.all { it.second.isNotBlank() && it.second.length <= 100 }, "names fit the column in $year")
        }
        assertEquals(0, PolishHolidays.of(2024).count { it.first == LocalDate.of(2024, 12, 24) }, "no Christmas Eve before 2025")
        assertEquals(LocalDate.of(2025, 12, 24), namedDate(2025, "Wigilia Bożego Narodzenia"))
    }

    @Test
    fun `the fixed dates and the Easter Monday of 2027 are the statutory ones`() {
        val byName = PolishHolidays.of(2027).associate { it.second to it.first }
        assertEquals(LocalDate.of(2027, 1, 1), byName["Nowy Rok"])
        assertEquals(LocalDate.of(2027, 1, 6), byName["Święto Trzech Króli"])
        assertEquals(LocalDate.of(2027, 3, 29), byName["Poniedziałek Wielkanocny"])
        assertEquals(LocalDate.of(2027, 5, 1), byName["Święto Pracy"])
        assertEquals(LocalDate.of(2027, 5, 3), byName["Święto Konstytucji 3 Maja"])
        assertEquals(LocalDate.of(2027, 8, 15), byName["Wniebowzięcie Najświętszej Maryi Panny"])
        assertEquals(LocalDate.of(2027, 11, 1), byName["Wszystkich Świętych"])
        assertEquals(LocalDate.of(2027, 11, 11), byName["Narodowe Święto Niepodległości"])
        assertEquals(LocalDate.of(2027, 12, 25), byName["Boże Narodzenie (pierwszy dzień)"])
        assertEquals(LocalDate.of(2027, 12, 26), byName["Boże Narodzenie (drugi dzień)"])
    }
}
