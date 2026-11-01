package ch.nokillswit

import ch.nokillswit.planning.PublicHolidayCreateRequest
import ch.nokillswit.planning.PublicHolidayList
import ch.nokillswit.planning.PublicHolidayResponse
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The public-holiday dictionary (`public_holidays`, V19): GET any authenticated, POST/DELETE ADMIN-only, hard-deleting, unique per
 * date, and a plan write. The table is GLOBAL shared state in the shared container (and starts empty), so the tests use far-off years
 * (2085-2089; `HolidayPresetTest` owns 2090+) and remove what they add.
 */
class PublicHolidayTest {

    private suspend fun HttpClient.createHoliday(date: String, name: String): HttpResponse =
        postJson("/api/v1/public-holidays", PublicHolidayCreateRequest(date, name))

    @Test
    fun `the dictionary is readable by any authenticated user and ordered by date`() = testApplication {
        usePostgresTestcontainer()
        val first = TestHolidays.service.create(PublicHolidayCreateRequest("2085-01-06", "Epiphany")).value
        val second = TestHolidays.service.create(PublicHolidayCreateRequest("2085-05-01", "Labour Day")).value
        try {
            assertEquals(HttpStatusCode.Unauthorized, jsonClient().get("/api/v1/public-holidays").status)
            val list = seededClient("holiday-reader", UserRole.USER).get("/api/v1/public-holidays").body<PublicHolidayList>()
            val ours = list.items.filter { it.id == first.id || it.id == second.id }
            assertEquals(listOf("2085-01-06", "2085-05-01"), ours.map { it.date })
            assertEquals("Epiphany", ours.first().name)
            assertEquals(list.items.sortedBy { it.date }, list.items, "ordered by date over the whole dictionary")
        } finally {
            TestHolidays.remove(first.id)
            TestHolidays.remove(second.id)
        }
    }

    @Test
    fun `mutations are ADMIN-only and the guard runs before the body and the id lookup`() = testApplication {
        usePostgresTestcontainer()
        val plain = seededClient("holiday-plain", UserRole.USER)
        val existing = TestHolidays.service.create(PublicHolidayCreateRequest("2085-06-16", "Some Day")).value
        try {
            val before = TestPlan.revision()
            assertEquals(HttpStatusCode.Forbidden, plain.createHoliday("2085-06-17", "Blocked").status)
            assertEquals(HttpStatusCode.Forbidden, plain.createHoliday("garbage", " ").status, "403 wins over the 400 shape check")
            assertEquals(HttpStatusCode.Forbidden, plain.delete("/api/v1/public-holidays/${existing.id}").status)
            assertEquals(HttpStatusCode.Forbidden, plain.delete("/api/v1/public-holidays/999999999").status, "and over the 404")
            assertEquals(HttpStatusCode.Unauthorized, jsonClient().delete("/api/v1/public-holidays/${existing.id}").status)
            assertTrue(TestHolidays.service.list().any { it.id == existing.id }, "nothing was deleted")
            assertEquals(before, TestPlan.revision(), "a refused write never moves the plan revision")
        } finally {
            TestHolidays.remove(existing.id)
        }
    }

    @Test
    fun `create validates the shape, trims the name and rejects a duplicate date with 409`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("holiday-admin", UserRole.ADMIN)

        for ((date, name) in listOf(
            "2086-1-06" to "Sloppy", "garbage" to "Nope", "2086-02-30" to "Nope", "+12086-01-06" to "Nope", "2086-01-06 " to "Nope",
            "1899-12-31" to "Too early", "3000-01-01" to "Too late",
            "2086-01-06" to "  ", "2086-01-06" to "x".repeat(101), "2086-01-06" to "tab\there",
        )) {
            assertEquals(HttpStatusCode.BadRequest, admin.createHoliday(date, name).status, "expected 400 for '$date' / '$name'")
        }
        assertEquals(HttpStatusCode.BadRequest, admin.delete("/api/v1/public-holidays/-1").status, "a negative id is a 400")

        val response = admin.createHoliday("2086-01-06", "  Epiphany  ")
        assertEquals(HttpStatusCode.Created, response.status)
        val created = response.body<PublicHolidayResponse>()
        try {
            assertEquals("/api/v1/public-holidays/${created.id}", response.headers["Location"])
            assertEquals("2086-01-06", created.date)
            assertEquals("Epiphany", created.name, "trimmed")
            val duplicate = admin.createHoliday("2086-01-06", "Duplicate")
            assertEquals(HttpStatusCode.Conflict, duplicate.status, "one holiday per date")
            assertContains(duplicate.bodyAsText(), "A holiday already exists on this date", message = "the SPA relies on this detail")
            assertEquals(1, TestHolidays.service.list().count { it.date == "2086-01-06" })
            assertEquals("Epiphany", TestHolidays.service.list().single { it.date == "2086-01-06" }.name, "the loser did not overwrite")
        } finally {
            TestHolidays.remove(created.id)
        }
    }

    @Test
    fun `a holiday on a weekend is stored like any other`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("holiday-weekend", UserRole.ADMIN)
        val sunday = "2086-03-03" // a Sunday
        val created = admin.createHoliday(sunday, "Sunday holiday")
        assertEquals(HttpStatusCode.Created, created.status)
        val id = created.body<PublicHolidayResponse>().id
        try {
            assertEquals(java.time.DayOfWeek.SUNDAY, java.time.LocalDate.parse(sunday).dayOfWeek)
            assertTrue(admin.get("/api/v1/public-holidays").body<PublicHolidayList>().items.any { it.id == id && it.date == sunday })
        } finally {
            TestHolidays.remove(id)
        }
    }

    @Test
    fun `delete is a hard delete, 404s on a missing id and frees the date`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("holiday-del", UserRole.ADMIN)
        val id = TestHolidays.service.create(PublicHolidayCreateRequest("2087-03-03", "Disposable")).value.id
        var again: PublicHolidayResponse? = null
        try {
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/public-holidays/$id").status)
            assertEquals(HttpStatusCode.NotFound, admin.delete("/api/v1/public-holidays/$id").status)
            assertTrue(admin.get("/api/v1/public-holidays").body<PublicHolidayList>().items.none { it.id == id })
            again = TestHolidays.service.create(PublicHolidayCreateRequest("2087-03-03", "Again")).value
        } finally {
            TestHolidays.remove(id)
            again?.let { TestHolidays.remove(it.id) }
        }
    }

    @Test
    fun `a create and a delete each bump the plan revision by one, a duplicate and a missing delete do not`() = testApplication {
        usePostgresTestcontainer()
        val admin = seededClient("holiday-revision", UserRole.ADMIN)
        val start = TestPlan.revision()

        val created = admin.createHoliday("2089-02-02", "Revision day").body<PublicHolidayResponse>()
        try {
            assertEquals(start + 1, TestPlan.revision())
            assertEquals(HttpStatusCode.Conflict, admin.createHoliday("2089-02-02", "Again").status)
            assertEquals(HttpStatusCode.NotFound, admin.delete("/api/v1/public-holidays/999999999").status)
            assertEquals(HttpStatusCode.BadRequest, admin.createHoliday("garbage", "Nope").status)
            assertEquals(start + 1, TestPlan.revision(), "neither the rolled-back duplicate nor the missing delete nor a 400 moves it")
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/public-holidays/${created.id}").status)
            assertEquals(start + 2, TestPlan.revision())
        } finally {
            TestHolidays.remove(created.id)
        }
    }

    @Test
    fun `holiday mutations land in the security audit trail`() = testApplication {
        usePostgresTestcontainer()
        val adminEmail = uniqueEmail("holiday-audit-admin")
        val adminId = TestUsers.seed(adminEmail, "pw")
        val admin = authedClient(adminEmail, "pw")
        withAuditCapture { capture ->
            val created = admin.createHoliday("2088-11-11", "Independence Day").body<PublicHolidayResponse>()
            val afterCreate = TestPlan.revision()
            admin.delete("/api/v1/public-holidays/${created.id}")
            val afterDelete = TestPlan.revision()

            val createdEvent = assertNotNull(
                capture.awaitEvent { it.message == "public_holiday.created" && it.hasKeyValue("holidayId", created.id.toLong()) },
            )
            assertTrue(createdEvent.hasKeyValue("byUserId", adminId.toLong()))
            assertTrue(createdEvent.hasKeyValue("date", "2088-11-11"))
            assertTrue(createdEvent.hasKeyValue("name", "Independence Day"))
            assertTrue(createdEvent.hasKeyValue("revisionTo", afterCreate))
            val deletedEvent = assertNotNull(
                capture.awaitEvent { it.message == "public_holiday.deleted" && it.hasKeyValue("holidayId", created.id.toLong()) },
            )
            assertTrue(deletedEvent.hasKeyValue("byUserId", adminId.toLong()))
            assertTrue(deletedEvent.hasKeyValue("date", "2088-11-11"))
            assertTrue(deletedEvent.hasKeyValue("revisionTo", afterDelete))
        }
    }
}
