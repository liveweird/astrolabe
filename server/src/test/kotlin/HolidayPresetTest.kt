package ch.nokillswit

import ch.nokillswit.planning.HolidayPreset
import ch.nokillswit.planning.HolidayPresetRequest
import ch.nokillswit.planning.HolidayPresetResponse
import ch.nokillswit.planning.PolishHolidays
import ch.nokillswit.planning.PublicHolidayCreateRequest
import ch.nokillswit.planning.PublicHolidayList
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

/**
 * `POST /public-holidays/apply-preset`: the Polish set for a year, idempotent, ADMIN-only (guard before the body), a plan write that
 * bumps the revision once even when nothing is added. The dictionary is global shared state: this class owns the years 2090-2095
 * (`PublicHolidayTest` owns 2085-2089) and clears them afterwards.
 */
class HolidayPresetTest {

    @AfterTest
    fun clear() = runBlocking {
        (listOf(1900, 2999) + (2090..2095)).forEach { TestHolidays.clearYear(it) }
    }

    private suspend fun HttpClient.applyPolish(year: Int): HttpResponse =
        postJson("/api/v1/public-holidays/apply-preset", HolidayPresetRequest(HolidayPreset.POLISH, year))

    private suspend fun HttpClient.rawApply(body: String): HttpResponse = postJson("/api/v1/public-holidays/apply-preset", body)

    @Test
    fun `applying the Polish preset stores the whole year, Sunday-only days included, and answers what it added`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("preset-admin", UserRole.ADMIN)
        val expected = PolishHolidays.of(2090)

        val response = admin.applyPolish(2090)
        assertEquals(HttpStatusCode.OK, response.status)
        val applied = response.body<HolidayPresetResponse>()
        assertEquals(expected.map { it.first.toString() to it.second }, applied.added.map { it.date to it.name })
        assertTrue(applied.skipped.isEmpty())
        assertEquals(14, applied.added.size)
        val easter = applied.added.single { it.name == "Wielkanoc" }
        assertEquals(java.time.DayOfWeek.SUNDAY, java.time.LocalDate.parse(easter.date).dayOfWeek, "Sunday-only entries are stored too")

        val stored = admin.get("/api/v1/public-holidays").body<PublicHolidayList>().items.filter { it.date.startsWith("2090-") }
        assertEquals(applied.added, stored, "the answer carries the stored rows, ids included")
    }

    @Test
    fun `re-applying adds nothing, keeps every existing name and lists the skipped dates`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("preset-again", UserRole.ADMIN)
        TestHolidays.service.create(PublicHolidayCreateRequest("2091-01-01", "Custom New Year"))
        TestHolidays.service.create(PublicHolidayCreateRequest("2091-03-04", "Unrelated day in the same year"))

        val first = admin.applyPolish(2091).body<HolidayPresetResponse>()
        assertEquals(listOf("2091-01-01"), first.skipped, "only the date the set shares with the dictionary is skipped")
        assertEquals(13, first.added.size)
        assertTrue(first.added.none { it.date == "2091-01-01" })

        val second = admin.applyPolish(2091).body<HolidayPresetResponse>()
        assertTrue(second.added.isEmpty(), "idempotent")
        assertEquals(PolishHolidays.of(2091).map { it.first.toString() }, second.skipped)

        val rows = TestHolidays.service.list().filter { it.date.startsWith("2091-") }
        assertEquals("Custom New Year", rows.single { it.date == "2091-01-01" }.name, "the preset never renames")
        assertEquals(15, rows.size, "the 14 of the set plus the unrelated day")
    }

    @Test
    fun `a year outside 1900-2999 and an unknown preset are 400, and a rejected request changes nothing`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("preset-400", UserRole.ADMIN)
        val before = TestPlan.revision()
        val rejected = listOf(
            """{"preset":"POLISH","year":1899}""",
            """{"preset":"POLISH","year":3000}""",
            """{"preset":"POLISH","year":-5}""",
            """{"preset":"FRENCH","year":2092}""",
            """{"preset":"POLISH"}""",
            """{"year":2092}""",
            """{"preset":"POLISH","year":"soon"}""",
        )
        for (body in rejected) assertEquals(HttpStatusCode.BadRequest, admin.rawApply(body).status, body)
        assertEquals(before, TestPlan.revision(), "no 400 moves the plan revision")
        assertTrue(TestHolidays.service.list().none { it.date.startsWith("2092-") })
        assertEquals(HttpStatusCode.OK, admin.applyPolish(1900).status, "the lower bound is accepted")
        assertEquals(HttpStatusCode.OK, admin.applyPolish(2999).status, "and so is the upper")
        // 1900 and 2999 are cleared by the @AfterTest, so a failing assertion above cannot leave them in the shared container.
    }

    @Test
    fun `only ADMIN may apply a preset and the guard runs before the body is read`() = testApplication {
        usePostgresTestcontainer()
        val plain = seededClient("preset-plain", UserRole.USER)
        val before = TestPlan.revision()
        assertEquals(HttpStatusCode.Forbidden, plain.applyPolish(2093).status)
        assertEquals(HttpStatusCode.Forbidden, plain.rawApply("{ not json").status, "a malformed body stays 403")
        assertEquals(HttpStatusCode.Forbidden, plain.rawApply("""{"preset":"FRENCH","year":1}""").status, "and so does an invalid one")
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().applyPolish(2093).status)
        assertTrue(TestHolidays.service.list().none { it.date.startsWith("2093-") })
        assertEquals(before, TestPlan.revision())
    }

    @Test
    fun `an application is one plan write - even a re-application that adds nothing bumps the revision once`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("preset-rev", UserRole.ADMIN)
        val start = TestPlan.revision()
        assertEquals(HttpStatusCode.OK, admin.applyPolish(2094).status)
        assertEquals(start + 1, TestPlan.revision(), "14 inserts, ONE bump")
        assertEquals(HttpStatusCode.OK, admin.applyPolish(2094).status)
        assertEquals(start + 2, TestPlan.revision(), "the conservative rule: a no-op application still bumps")
    }

    @Test
    fun `an application lands in the audit trail with what it added`() = testApplication {
        usePostgresTestcontainer()
        val adminEmail = uniqueEmail("preset-audit")
        val adminId = TestUsers.seed(adminEmail, "pw")
        val admin = authedClient(adminEmail, "pw")
        withAuditCapture { capture ->
            admin.applyPolish(2095)
            val afterFirst = TestPlan.revision()
            admin.applyPolish(2095)
            val afterSecond = TestPlan.revision()

            val first = assertNotNull(
                capture.awaitEvent { it.message == "public_holiday.preset_applied" && it.hasKeyValue("revisionTo", afterFirst) },
            )
            assertTrue(first.hasKeyValue("byUserId", adminId.toLong()))
            assertTrue(first.hasKeyValue("preset", "POLISH"))
            assertTrue(first.hasKeyValue("year", 2095))
            assertTrue(first.hasKeyValue("addedCount", 14))
            assertTrue(first.hasKeyValue("addedDates", PolishHolidays.of(2095).joinToString(",") { it.first.toString() }))
            val second = assertNotNull(
                capture.awaitEvent { it.message == "public_holiday.preset_applied" && it.hasKeyValue("revisionTo", afterSecond) },
            )
            assertTrue(second.hasKeyValue("addedCount", 0))
            assertTrue(second.hasKeyValue("addedDates", ""))
        }
    }
}
