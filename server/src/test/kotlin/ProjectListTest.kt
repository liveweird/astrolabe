package ch.nokillswit

import ch.nokillswit.planning.ProjectPageResponse
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
import kotlin.test.assertTrue

/**
 * `GET /api/v1/projects` (v0.4.0 C2, the dependency pickers' project search): any authenticated user, paged per `list-endpoints.md`,
 * one `name` filter (case- and accent-insensitive), the program's and work stream's names on every row, ACTIVE rows with active
 * ancestors only. The plan tables are SHARED suite state - every row carries a unique marker and every assertion filters on it.
 */
class ProjectListTest {
    private val ok = HttpStatusCode.OK
    private val badRequest = HttpStatusCode.BadRequest

    private fun marker() = UUID.randomUUID().toString().substring(0, 8)

    private suspend fun HttpClient.projects(vararg params: Pair<String, String>): HttpResponse =
        get("/api/v1/projects") { params.forEach { (key, value) -> url.parameters.append(key, value) } }

    @Test
    fun `an unauthenticated list is 401`() = testApplication {
        usePostgresTestcontainer()
        assertEquals(HttpStatusCode.Unauthorized, jsonClient().get("/api/v1/projects").status)
    }

    @Test
    fun `any authenticated caller reads the list - the person-less and the stranger too`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pl-any")
        for ((who, caller) in w.outsiders + ("projectOwner" to w.projectOwner) + ("admin" to w.admin)) {
            assertEquals(ok, caller.client.projects("pageSize" to "1").status, who)
        }
    }

    @Test
    fun `paging, sort and filter violations are 400`() = testApplication {
        usePostgresTestcontainer()
        val client = planCaller("pl-bad").client
        assertEquals(badRequest, client.projects("page" to "0").status)
        assertEquals(badRequest, client.projects("page" to "x").status)
        assertEquals(badRequest, client.projects("pageSize" to "101").status)
        assertEquals(badRequest, client.projects("pageSize" to "0").status)
        assertEquals(badRequest, client.projects("sort" to "ownerName").status, "owner is not sortable")
        assertEquals(badRequest, client.projects("sort" to "-programName").status, "the joined names are not sortable")
        assertEquals(badRequest, client.projects("name" to "a", "name" to "b").status, "a repeated scalar key is a 400")
    }

    @Test
    fun `the name filter is case- and accent-insensitive and total is counted after it`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pl-filter")
        val tag = marker()
        val zolw = TestPlan.project(w.programId, w.projectOwner.personId!!, name = "Żółw $tag")
        val plain = TestPlan.project(w.programId, w.projectOwner.personId, name = "Zolw $tag two")
        TestPlan.project(w.programId, w.projectOwner.personId, name = "Other ${marker()}")
        val client = w.stranger.client

        val byAscii = client.projects("name" to "zolw $tag", "sort" to "id").body<ProjectPageResponse>()
        assertEquals(listOf(zolw, plain), byAscii.items.map { it.id })
        assertEquals(2L, byAscii.total)
        // Uppercase diacritics fold too (unaccent runs before LOWER).
        val byUpper = client.projects("name" to "ŻÓŁW $tag").body<ProjectPageResponse>()
        assertEquals(setOf(zolw, plain), byUpper.items.map { it.id }.toSet())
        // `total` is after the filter and before pagination.
        val firstPage = client.projects("name" to tag, "pageSize" to "1").body<ProjectPageResponse>()
        assertEquals(1, firstPage.items.size)
        assertEquals(2L, firstPage.total)
        assertEquals(1, firstPage.pageSize)
        val secondPage = client.projects("name" to tag, "pageSize" to "1", "page" to "2").body<ProjectPageResponse>()
        assertEquals(listOf(plain), secondPage.items.map { it.id })
        // LIKE metacharacters in the filter are literals, a blank filter is no filter.
        assertEquals(0L, client.projects("name" to "$tag%").body<ProjectPageResponse>().total)
        assertTrue(client.projects("name" to "  ").body<ProjectPageResponse>().total >= 3)
    }

    @Test
    fun `rows carry the program and work stream names and the owner`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pl-names")
        val tag = marker()
        val streamName = "Stream $tag"
        val programName = "Program $tag"
        val streamId = TestPlan.workStream(w.streamOwner.personId!!, name = streamName)
        val programId = TestPlan.program(streamId, w.programOwner.personId!!, name = programName)
        val projectId = TestPlan.project(
            programId, w.projectOwner.personId!!, name = "Alpha $tag", targetStart = "2027-03-01", targetEnd = "2027-04-30",
        )

        val item = w.stranger.client.projects("name" to "alpha $tag").body<ProjectPageResponse>().items.single()
        assertEquals(projectId, item.id)
        assertEquals(programId, item.programId)
        assertEquals(streamId, item.workStreamId)
        assertEquals(programName, item.programName)
        assertEquals(streamName, item.workStreamName)
        assertEquals(w.projectOwner.personId, item.ownerPersonId)
        assertTrue(item.ownerName.isNotBlank())
        assertEquals("2027-03-01", item.targetStart)
        assertEquals("2027-04-30", item.targetEnd)
        assertEquals(null, item.description)
    }

    @Test
    fun `the default sort is id ascending and the explicit sorts apply with the id tiebreaker`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pl-sort")
        val tag = marker()
        val owner = w.projectOwner.personId!!
        val b = TestPlan.project(w.programId, owner, name = "B $tag")
        val a = TestPlan.project(w.programId, owner, name = "A $tag")
        val c = TestPlan.project(w.programId, owner, name = "C $tag")
        val client = w.stranger.client

        assertEquals(listOf(b, a, c), client.projects("name" to tag).body<ProjectPageResponse>().items.map { it.id })
        assertEquals(listOf(a, b, c), client.projects("name" to tag, "sort" to "name").body<ProjectPageResponse>().items.map { it.id })
        assertEquals(listOf(c, b, a), client.projects("name" to tag, "sort" to "-name").body<ProjectPageResponse>().items.map { it.id })
        // createdAt/updatedAt may tie within a millisecond (the id tiebreaker then orders the tie): the whitelist is what is pinned.
        for (field in listOf("createdAt", "-createdAt", "updatedAt", "-updatedAt")) {
            val ids = client.projects("name" to tag, "sort" to field).body<ProjectPageResponse>().items.map { it.id }
            assertEquals(setOf(a, b, c), ids.toSet(), field)
        }
    }

    @Test
    fun `a deleted project is absent and a project under no ancestor chain is never listed`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pl-del")
        val tag = marker()
        val owner = w.projectOwner.personId!!
        val kept = TestPlan.project(w.programId, owner, name = "Kept $tag")
        val gone = TestPlan.project(w.programId, owner, name = "Gone $tag")
        val client = w.stranger.client
        assertEquals(setOf(kept, gone), client.projects("name" to tag).body<ProjectPageResponse>().items.map { it.id }.toSet())

        assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/$gone").status)
        val after = client.projects("name" to tag).body<ProjectPageResponse>()
        assertEquals(listOf(kept), after.items.map { it.id })
        assertEquals(1L, after.total)

        // A project of a deleted program cannot exist (the program delete is 409 while it has projects); the soft-deleted program's
        // own projects are removed first, then the program, and the list holds none of them.
        val streamId = TestPlan.workStream(w.streamOwner.personId!!)
        val programId = TestPlan.program(streamId, w.programOwner.personId!!)
        val under = TestPlan.project(programId, owner, name = "Under $tag")
        assertEquals(listOf(under), client.projects("name" to "under $tag").body<ProjectPageResponse>().items.map { it.id })
        assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("/api/v1/projects/$under").status)
        assertEquals(HttpStatusCode.NoContent, w.programOwner.client.delete("/api/v1/programs/$programId").status)
        assertEquals(0L, client.projects("name" to "under $tag").body<ProjectPageResponse>().total)
    }
}
