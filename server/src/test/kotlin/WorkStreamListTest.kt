package ch.nokillswit

import ch.nokillswit.planning.WorkStreamPageResponse
import ch.nokillswit.planning.WorkStreamResponse
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /api/v1/work-streams` (1.26.0 A1): any authenticated user, paged per `list-endpoints.md`, one `name` filter (case- and
 * accent-insensitive), ACTIVE rows only, each row the same `WorkStreamResponse` as `GET /work-streams/{id}`. The plan tables are SHARED
 * suite state - every row carries a unique marker and every assertion filters on it.
 */
class WorkStreamListTest {
    private val ok = HttpStatusCode.OK
    private val badRequest = HttpStatusCode.BadRequest

    private fun marker() = UUID.randomUUID().toString().substring(0, 8)

    private suspend fun HttpClient.workStreams(vararg params: Pair<String, String>): HttpResponse =
        get("/api/v1/work-streams") { params.forEach { (key, value) -> url.parameters.append(key, value) } }

    /** The ids of the page of the work streams named [tag], in [sort] order (the default order when null). */
    private suspend fun HttpClient.idsOf(tag: String, sort: String? = null): List<UInt> =
        workStreams(*listOfNotNull("name" to tag, sort?.let { "sort" to it }).toTypedArray())
            .body<WorkStreamPageResponse>().items.map { it.id }

    @Test
    fun `an unauthenticated list is 401`() = testApplication {
        usePostgresTestcontainer()
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get("/api/v1/work-streams").status)
    }

    @Test
    fun `any authenticated caller reads the list - the person-less and the stranger too`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("wl-any")
        for ((who, caller) in w.outsiders + ("streamOwner" to w.streamOwner) + ("admin" to w.admin)) {
            assertEquals(ok, caller.client.workStreams("pageSize" to "1").status, who)
        }
    }

    @Test
    fun `paging, sort and filter violations are 400`() = testApplication {
        usePostgresTestcontainer()
        val client = planCaller("wl-bad").client
        assertEquals(badRequest, client.workStreams("page" to "0").status)
        assertEquals(badRequest, client.workStreams("page" to "x").status)
        assertEquals(badRequest, client.workStreams("pageSize" to "101").status)
        assertEquals(badRequest, client.workStreams("pageSize" to "0").status)
        assertEquals(badRequest, client.workStreams("sort" to "ownerName").status, "owner is not sortable")
        assertEquals(badRequest, client.workStreams("sort" to "-endDate").status, "the end date is not sortable")
        assertEquals(badRequest, client.workStreams("name" to "a", "name" to "b").status, "a repeated scalar key is a 400")
    }

    @Test
    fun `the name filter is case- and accent-insensitive and total is counted after it`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("wl-filter")
        val tag = marker()
        val owner = w.streamOwner.personId!!
        val zolw = TestPlan.workStream(owner, name = "Żółw $tag")
        val plain = TestPlan.workStream(owner, name = "Zolw $tag two")
        TestPlan.workStream(owner, name = "Other ${marker()}")
        val client = w.stranger.client

        val byAscii = client.workStreams("name" to "zolw $tag", "sort" to "id").body<WorkStreamPageResponse>()
        assertEquals(listOf(zolw, plain), byAscii.items.map { it.id })
        assertEquals(2L, byAscii.total)
        // Uppercase diacritics fold too (unaccent runs before LOWER).
        val byUpper = client.workStreams("name" to "ŻÓŁW $tag").body<WorkStreamPageResponse>()
        assertEquals(setOf(zolw, plain), byUpper.items.map { it.id }.toSet())
        // `total` is after the filter and before pagination.
        val firstPage = client.workStreams("name" to tag, "pageSize" to "1").body<WorkStreamPageResponse>()
        assertEquals(1, firstPage.items.size)
        assertEquals(2L, firstPage.total)
        assertEquals(1, firstPage.pageSize)
        val secondPage = client.workStreams("name" to tag, "pageSize" to "1", "page" to "2").body<WorkStreamPageResponse>()
        assertEquals(listOf(plain), secondPage.items.map { it.id })
        // LIKE metacharacters in the filter are literals, a blank filter is no filter.
        assertEquals(0L, client.workStreams("name" to "$tag%").body<WorkStreamPageResponse>().total)
        assertTrue(client.workStreams("name" to "  ").body<WorkStreamPageResponse>().total >= 3)
    }

    @Test
    fun `rows are the work stream response - owner, dates and the open or closed end`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("wl-rows")
        val tag = marker()
        val open = TestPlan.workStream(w.streamOwner.personId!!, name = "Open $tag", startDate = "2027-01-04")
        val closed = TestPlan.workStream(w.streamOwner.personId, name = "Closed $tag", startDate = "2026-02-02", endDate = "2026-12-18")
        val client = w.stranger.client

        val items = client.workStreams("name" to tag).body<WorkStreamPageResponse>().items.associateBy { it.id }
        val openRow = items.getValue(open)
        assertEquals("2027-01-04", openRow.startDate)
        assertNull(openRow.endDate)
        assertEquals(w.streamOwner.personId, openRow.ownerPersonId)
        assertTrue(openRow.ownerName.isNotBlank())
        assertNull(openRow.description)
        val closedRow = items.getValue(closed)
        assertEquals("2026-02-02", closedRow.startDate)
        assertEquals("2026-12-18", closedRow.endDate)
        // The row is exactly what the single read answers.
        assertEquals(closedRow, client.get("/api/v1/work-streams/$closed").body<WorkStreamResponse>())
    }

    @Test
    fun `the default sort is id ascending and the explicit sorts apply with the id tiebreaker`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("wl-sort")
        val tag = marker()
        val owner = w.streamOwner.personId!!
        val b = TestPlan.workStream(owner, name = "B $tag", startDate = "2026-03-01")
        val a = TestPlan.workStream(owner, name = "A $tag", startDate = "2026-05-01")
        val c = TestPlan.workStream(owner, name = "C $tag", startDate = "2026-01-01")
        val client = w.stranger.client

        assertEquals(listOf(b, a, c), client.idsOf(tag))
        assertEquals(listOf(a, b, c), client.idsOf(tag, "name"))
        assertEquals(listOf(c, b, a), client.idsOf(tag, "-name"))
        assertEquals(listOf(c, b, a), client.idsOf(tag, "startDate"))
        assertEquals(listOf(a, b, c), client.idsOf(tag, "-startDate"))
        // createdAt/updatedAt may tie within a millisecond (the id tiebreaker then orders the tie): the whitelist is what is pinned.
        for (field in listOf("createdAt", "-createdAt", "updatedAt", "-updatedAt")) {
            val ids = client.workStreams("name" to tag, "sort" to field).body<WorkStreamPageResponse>().items.map { it.id }
            assertEquals(setOf(a, b, c), ids.toSet(), field)
        }
    }

    @Test
    fun `a deleted work stream is absent`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("wl-del")
        val tag = marker()
        val owner = w.streamOwner.personId!!
        val kept = TestPlan.workStream(owner, name = "Kept $tag")
        val gone = TestPlan.workStream(owner, name = "Gone $tag")
        val client = w.stranger.client
        assertEquals(setOf(kept, gone), client.workStreams("name" to tag).body<WorkStreamPageResponse>().items.map { it.id }.toSet())

        assertEquals(HttpStatusCode.NoContent, w.streamOwner.client.delete("/api/v1/work-streams/$gone").status)
        val after = client.workStreams("name" to tag).body<WorkStreamPageResponse>()
        assertEquals(listOf(kept), after.items.map { it.id })
        assertEquals(1L, after.total)
    }
}
