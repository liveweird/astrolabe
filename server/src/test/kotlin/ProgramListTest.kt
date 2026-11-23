package ch.nokillswit

import ch.nokillswit.planning.ProgramPageResponse
import ch.nokillswit.planning.ProgramResponse
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
 * `GET /api/v1/programs` (1.26.0 A1, the Jira bind dialog's program picker): any authenticated user, paged per `list-endpoints.md`, the
 * filters `name` (case- and accent-insensitive) and `workStreamId` (ANDed), the work stream's name on every row, ACTIVE rows under an
 * active work stream only. The plan tables are SHARED suite state - every row carries a unique marker and every assertion filters on it.
 */
class ProgramListTest {
    private val ok = HttpStatusCode.OK
    private val badRequest = HttpStatusCode.BadRequest

    private fun marker() = UUID.randomUUID().toString().substring(0, 8)

    private suspend fun HttpClient.programs(vararg params: Pair<String, String>): HttpResponse =
        get("/api/v1/programs") { params.forEach { (key, value) -> url.parameters.append(key, value) } }

    @Test
    fun `an unauthenticated list is 401`() = testApplication {
        usePostgresTestcontainer()
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get("/api/v1/programs").status)
    }

    @Test
    fun `any authenticated caller reads the list - the person-less and the stranger too`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("gl-any")
        for ((who, caller) in w.outsiders + ("programOwner" to w.programOwner) + ("admin" to w.admin)) {
            assertEquals(ok, caller.client.programs("pageSize" to "1").status, who)
        }
    }

    @Test
    fun `paging, sort and filter violations are 400`() = testApplication {
        usePostgresTestcontainer()
        val client = planCaller("gl-bad").client
        assertEquals(badRequest, client.programs("page" to "0").status)
        assertEquals(badRequest, client.programs("page" to "x").status)
        assertEquals(badRequest, client.programs("pageSize" to "101").status)
        assertEquals(badRequest, client.programs("pageSize" to "0").status)
        assertEquals(badRequest, client.programs("sort" to "ownerName").status, "owner is not sortable")
        assertEquals(badRequest, client.programs("sort" to "-workStreamName").status, "the joined name is not sortable")
        assertEquals(badRequest, client.programs("name" to "a", "name" to "b").status, "a repeated scalar key is a 400")
        assertEquals(badRequest, client.programs("workStreamId" to "1", "workStreamId" to "2").status, "a repeated id is a 400")
        assertEquals(badRequest, client.programs("workStreamId" to "x").status, "a malformed id is a 400")
        assertEquals(badRequest, client.programs("workStreamId" to "-1").status, "a negative id is a 400")
    }

    @Test
    fun `the name filter is case- and accent-insensitive and total is counted after it`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("gl-filter")
        val tag = marker()
        val owner = w.programOwner.personId!!
        val zolw = TestPlan.program(w.streamId, owner, name = "Żółw $tag")
        val plain = TestPlan.program(w.streamId, owner, name = "Zolw $tag two")
        TestPlan.program(w.streamId, owner, name = "Other ${marker()}")
        val client = w.stranger.client

        val byAscii = client.programs("name" to "zolw $tag", "sort" to "id").body<ProgramPageResponse>()
        assertEquals(listOf(zolw, plain), byAscii.items.map { it.id })
        assertEquals(2L, byAscii.total)
        // Uppercase diacritics fold too (unaccent runs before LOWER).
        val byUpper = client.programs("name" to "ŻÓŁW $tag").body<ProgramPageResponse>()
        assertEquals(setOf(zolw, plain), byUpper.items.map { it.id }.toSet())
        // `total` is after the filter and before pagination.
        val firstPage = client.programs("name" to tag, "pageSize" to "1").body<ProgramPageResponse>()
        assertEquals(1, firstPage.items.size)
        assertEquals(2L, firstPage.total)
        assertEquals(1, firstPage.pageSize)
        val secondPage = client.programs("name" to tag, "pageSize" to "1", "page" to "2").body<ProgramPageResponse>()
        assertEquals(listOf(plain), secondPage.items.map { it.id })
        // LIKE metacharacters in the filter are literals, a blank filter is no filter.
        assertEquals(0L, client.programs("name" to "$tag%").body<ProgramPageResponse>().total)
        assertTrue(client.programs("name" to "  ").body<ProgramPageResponse>().total >= 3)
    }

    @Test
    fun `workStreamId narrows to one work stream, an unknown id is an empty page, and it is ANDed with name`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("gl-ws")
        val tag = marker()
        val owner = w.programOwner.personId!!
        val otherStream = TestPlan.workStream(w.streamOwner.personId!!)
        val here = TestPlan.program(w.streamId, owner, name = "Here $tag")
        val hereToo = TestPlan.program(w.streamId, owner, name = "Also $tag")
        val there = TestPlan.program(otherStream, owner, name = "There $tag")
        val client = w.stranger.client

        val all = client.programs("name" to tag).body<ProgramPageResponse>()
        assertEquals(setOf(here, hereToo, there), all.items.map { it.id }.toSet())
        val inWorld = client.programs("workStreamId" to w.streamId.toString(), "name" to tag).body<ProgramPageResponse>()
        assertEquals(setOf(here, hereToo), inWorld.items.map { it.id }.toSet())
        assertEquals(2L, inWorld.total)
        val elsewhere = client.programs("workStreamId" to otherStream.toString()).body<ProgramPageResponse>()
        assertEquals(listOf(there), elsewhere.items.map { it.id })
        val both = client.programs("workStreamId" to w.streamId.toString(), "name" to "also $tag").body<ProgramPageResponse>()
        assertEquals(listOf(hereToo), both.items.map { it.id })
        // A blank id is no filter; an id naming no work stream matches nothing (an empty 200, never a 404).
        assertTrue(client.programs("workStreamId" to "", "name" to tag).body<ProgramPageResponse>().total >= 3)
        val unknown = client.programs("workStreamId" to "2147483000")
        assertEquals(ok, unknown.status)
        assertEquals(0L, unknown.body<ProgramPageResponse>().total)
    }

    @Test
    fun `rows carry the work stream name and the owner`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("gl-names")
        val tag = marker()
        val streamName = "Stream $tag"
        val streamId = TestPlan.workStream(w.streamOwner.personId!!, name = streamName)
        val programId = TestPlan.program(streamId, w.programOwner.personId!!, name = "Alpha $tag")

        val item = w.stranger.client.programs("name" to "alpha $tag").body<ProgramPageResponse>().items.single()
        assertEquals(programId, item.id)
        assertEquals(streamId, item.workStreamId)
        assertEquals(streamName, item.workStreamName)
        assertEquals(w.programOwner.personId, item.ownerPersonId)
        assertTrue(item.ownerName.isNotBlank())
        assertNull(item.description)
        // The row is the program response plus the work stream's name.
        val single = w.stranger.client.get("/api/v1/programs/$programId").body<ProgramResponse>()
        val asResponse = with(item) { ProgramResponse(id, workStreamId, name, description, ownerPersonId, ownerName, createdAt, updatedAt) }
        assertEquals(single, asResponse)
    }

    @Test
    fun `the default sort is id ascending and the explicit sorts apply with the id tiebreaker`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("gl-sort")
        val tag = marker()
        val owner = w.programOwner.personId!!
        val b = TestPlan.program(w.streamId, owner, name = "B $tag")
        val a = TestPlan.program(w.streamId, owner, name = "A $tag")
        val c = TestPlan.program(w.streamId, owner, name = "C $tag")
        val client = w.stranger.client

        assertEquals(listOf(b, a, c), client.programs("name" to tag).body<ProgramPageResponse>().items.map { it.id })
        assertEquals(listOf(a, b, c), client.programs("name" to tag, "sort" to "name").body<ProgramPageResponse>().items.map { it.id })
        assertEquals(listOf(c, b, a), client.programs("name" to tag, "sort" to "-name").body<ProgramPageResponse>().items.map { it.id })
        // createdAt/updatedAt may tie within a millisecond (the id tiebreaker then orders the tie): the whitelist is what is pinned.
        for (field in listOf("createdAt", "-createdAt", "updatedAt", "-updatedAt")) {
            val ids = client.programs("name" to tag, "sort" to field).body<ProgramPageResponse>().items.map { it.id }
            assertEquals(setOf(a, b, c), ids.toSet(), field)
        }
    }

    @Test
    fun `a deleted program is absent and a program of a deleted work stream is never listed`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("gl-del")
        val tag = marker()
        val owner = w.programOwner.personId!!
        val kept = TestPlan.program(w.streamId, owner, name = "Kept $tag")
        val gone = TestPlan.program(w.streamId, owner, name = "Gone $tag")
        val client = w.stranger.client
        assertEquals(setOf(kept, gone), client.programs("name" to tag).body<ProgramPageResponse>().items.map { it.id }.toSet())

        assertEquals(HttpStatusCode.NoContent, w.programOwner.client.delete("/api/v1/programs/$gone").status)
        val after = client.programs("name" to tag).body<ProgramPageResponse>()
        assertEquals(listOf(kept), after.items.map { it.id })
        assertEquals(1L, after.total)

        // The API refuses to delete a stream with programs (409), so the stream is soft-deleted under its ACTIVE program by
        // SQL: the stream's own predicate (not the program's) must keep the program out of both the rows and the total.
        val streamId = TestPlan.workStream(w.streamOwner.personId!!)
        val under = TestPlan.program(streamId, owner, name = "Under $tag")
        assertEquals(listOf(under), client.programs("name" to "under $tag").body<ProgramPageResponse>().items.map { it.id })
        assertEquals(HttpStatusCode.Conflict, w.streamOwner.client.delete("/api/v1/work-streams/$streamId").status)
        jbSql("UPDATE work_streams SET marked_as_deleted = TRUE WHERE id = ?", streamId.toInt())
        val hidden = client.programs("name" to "under $tag").body<ProgramPageResponse>()
        assertEquals(0L, hidden.total)
        assertTrue(hidden.items.isEmpty())
        assertEquals(0L, client.programs("workStreamId" to streamId.toString()).body<ProgramPageResponse>().total)
        jbSql("UPDATE work_streams SET marked_as_deleted = FALSE WHERE id = ?", streamId.toInt())
        assertEquals(HttpStatusCode.NoContent, w.programOwner.client.delete("/api/v1/programs/$under").status)
        assertEquals(HttpStatusCode.NoContent, w.streamOwner.client.delete("/api/v1/work-streams/$streamId").status)
        assertEquals(0L, client.programs("name" to "under $tag").body<ProgramPageResponse>().total)
        assertEquals(0L, client.programs("workStreamId" to streamId.toString()).body<ProgramPageResponse>().total)
    }
}
