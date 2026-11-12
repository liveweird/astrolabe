package ch.nokillswit

import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraLevel
import com.github.tomakehurst.wiremock.client.MappingBuilder
import com.github.tomakehurst.wiremock.client.WireMock.aResponse
import com.github.tomakehurst.wiremock.client.WireMock.get
import com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor
import com.github.tomakehurst.wiremock.client.WireMock.urlPathMatching
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import java.net.URI
import java.net.http.HttpRequest
import java.net.http.HttpResponse.BodyHandlers
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The rooted import's refusals (1.14): the `400`s of the request, the five causes of `409 urn:astrolabe:problem:jira-root-unusable`
 * (no link, a link through another connection of the site, and, through stub overrides, a by-id `404`, another id, a key outside the
 * connection's projects and another level), the `502` (a root the stub cannot list under) and the bucket's `429`, and the `400`s of the
 * defaults a root allows (the request cannot steer a row out of the root's subtree). A `409` of the root's read never asks Jira for a
 * listing. Each caller makes at most five calls a minute.
 */
class JiraImportChildrenErrorsTest {
    private val unusable = "urn:astrolabe:problem:jira-root-unusable"

    private val searchPattern = urlPathMatching(".*/rest/api/3/search/jql")

    /** The `jql` of every search that reached the stub since the last [JiraStubServer.resetRequests], in order. */
    private fun stubSearches(): List<String> =
        JiraStubServer.requests(getRequestedFor(searchPattern)).map { it.queryParameter("jql").firstValue() }

    private suspend fun HttpClient.rawPreview(id: UInt, body: String): HttpResponse =
        post("$JB_CONNECTIONS/$id/import-preview") {
            contentType(ContentType.Application.Json)
            setBody(body)
        }

    /** The stub's own document of [id], as the by-id read answers it. */
    private fun stubDocument(id: String): String {
        val url = "${JiraStubFixture.warm()}/ex/jira/${JiraStubServer.CLOUD_ID}/rest/api/3/issue/$id?fields=summary"
        val request = HttpRequest.newBuilder(URI.create(url)).header("Authorization", "Bearer probe").GET().build()
        return java.net.http.HttpClient.newHttpClient().send(request, BodyHandlers.ofString()).body()
    }

    private fun issueOverride(id: String, status: Int = 200, body: String = ""): MappingBuilder =
        get(urlPathMatching(".*/rest/api/3/issue/$id")).atPriority(1)
            .willReturn(aResponse().withStatus(status).withHeader("Content-Type", "application/json").withBody(body))

    private suspend fun HttpResponse.assertUnusable(label: String, vararg absent: String) {
        val text = bodyAsText()
        assertEquals(HttpStatusCode.Conflict, status, "$label: $text")
        val problem = jbJson.decodeFromString<ch.nokillswit.plugins.ProblemDetail>(text)
        assertEquals(unusable, problem.type, label)
        assertTrue(absent.none { it in text }, "$label: nothing of the site reaches the client: $text")
    }

    @Test
    fun `a MILESTONE root does not decode, and the sixth call of a minute is a 429 whatever it would have answered`() = testApplication {
        val f = importFixture("jce1", keys = listOf("IMC"))
        val admin = f.w.admin.client
        val owner = f.w.streamOwner.personId
        val body = """{"workStreamId":${f.w.streamId},"ownerPersonId":$owner,"root":{"level":"MILESTONE","nodeId":1}}"""
        assertEquals(HttpStatusCode.BadRequest, admin.rawPreview(f.connectionId, body).status)
        // Four more calls with a root nothing links: a 409 each, and none of them reaches Jira.
        for (call in 2..5) {
            assertEquals(HttpStatusCode.Conflict, admin.preview(f.connectionId, f.scope(root = programRoot(f))).status, "$call")
        }
        assertEquals(HttpStatusCode.TooManyRequests, admin.preview(f.connectionId, f.scope(root = programRoot(f))).status)
    }

    @Test
    fun `a root with no active link through this connection is the 409, also when another connection of the site holds the link`() =
        testApplication {
            val f = importFixture("jce2", keys = listOf("IMC"))
            val admin = f.w.admin.client
            admin.preview(f.connectionId, f.scope(root = programRoot(f))).assertUnusable("no link", "IMC-1", "99001")
            for (root in listOf(projectRoot(f))) {
                f.w.streamOwner.client.preview(f.connectionId, f.scope(root = root)).assertUnusable("no link, a project", "IMC-2")
            }
            // Another connection of the SAME site holds the link: it is not a link through THIS connection.
            val other = admin.jbConnection(jbRequest(site = f.site, keys = listOf("IMC")))
            admin.jbBind(other.id, ch.nokillswit.jira.JiraLevel.PROGRAM, f.w.programId, "IMC-1").jbBinding()
            JiraStubServer.resetRequests()
            f.w.streamOwner.client.preview(f.connectionId, f.scope(root = programRoot(f))).assertUnusable("another connection", "IMC-1")
            assertEquals(emptyList(), stubSearches(), "nothing was listed for a root that cannot be used")
        }

    @Test
    fun `the root's own read decides the 409 - a 404, another id, a key outside the connection's projects and another level`() =
        testApplication {
            val f = importFixture("jce3", keys = listOf("IMC"))
            f.linkProgram()
            val program = stubDocument("99001")
            val project = stubDocument("99002")
            assertTrue("\"key\":\"IMC-1\"" in program && "\"id\":\"99002\"" in project, "the documents have the edited shape")
            val causes = listOf(
                "a 404" to issueOverride("99001", 404, """{"errorMessages":["Issue does not exist"]}"""),
                "another id" to issueOverride("99001", body = project),
                "a moved key" to issueOverride("99001", body = program.replace("\"key\":\"IMC-1\"", "\"key\":\"OUT-1\"")),
                "another level" to issueOverride("99001", body = project.replace("\"id\":\"99002\"", "\"id\":\"99001\"")),
            )
            val spare = planCaller("jce3x", ch.nokillswit.users.UserRole.ADMIN, false)
            val callers = listOf(f.w.admin, f.w.streamOwner, f.w.programOwner, spare)
            for ((index, cause) in causes.withIndex()) {
                val override = JiraStubServer.addOverride(cause.second)
                try {
                    JiraStubServer.resetRequests()
                    callers[index].client.preview(f.connectionId, f.scope(root = programRoot(f)))
                        .assertUnusable(cause.first, "OUT-1", "IMC-1", "99001", f.token)
                    assertEquals(emptyList(), stubSearches(), "${cause.first}: no listing is asked for")
                } finally {
                    JiraStubServer.removeOverride(override)
                }
            }
        }

    @Test
    fun `a root read that fails for another reason is the 502 with the code only`() =
        testApplication {
            val f = importFixture("jce4", keys = listOf("IMC"))
            f.linkProgram()
            val admin = f.w.admin.client
            for ((status, code) in mapOf(403 to "FORBIDDEN_SCOPE", 500 to "UPSTREAM_UNAVAILABLE")) {
                val override = JiraStubServer.addOverride(issueOverride("99001", status))
                try {
                    val response = admin.preview(f.connectionId, f.scope(root = programRoot(f)))
                    val text = response.bodyAsText()
                    assertEquals(HttpStatusCode.BadGateway, response.status, "$status: $text")
                    val problem = jbJson.decodeFromString<ch.nokillswit.plugins.ProblemDetail>(text)
                    assertEquals("urn:astrolabe:problem:jira-upstream", problem.type)
                    assertEquals("Jira did not answer ($code)", problem.detail, "$status")
                    assertTrue(f.token !in text && "99001" !in text, "$status: $text")
                } finally {
                    JiraStubServer.removeOverride(override)
                }
            }
        }

    @Test
    fun `a root whose listing the stub refuses is the 502 with the code only`() = testApplication {
        val f = importFixture("jce5", keys = listOf("IMC"))
        // A program linked to IMC-11: the root reads, but no mapping lists `parent in (99011)`, so the stub refuses the search.
        f.linkProgram("IMC-11")
        val refused = f.w.admin.client.preview(f.connectionId, f.scope(root = programRoot(f)))
        val text = refused.bodyAsText()
        assertEquals(HttpStatusCode.BadGateway, refused.status, text)
        val problem = jbJson.decodeFromString<ch.nokillswit.plugins.ProblemDetail>(text)
        assertEquals("Jira did not answer (AUTHENTICATION_FAILED)", problem.detail)
        assertTrue(f.token !in text && "IMC-11" !in text && "99011" !in text, text)
    }

    private suspend fun HttpResponse.assertBadRequest(label: String, detail: String) {
        val text = bodyAsText()
        assertEquals(HttpStatusCode.BadRequest, status, "$label: $text")
        assertTrue(detail in jbProblem().detail.orEmpty(), "$label: $text")
    }

    @Test
    fun `with a program root defaults_programId and a project outside the root program are 400s, the 404 and the 403 come first`() =
        testApplication {
            val f = importFixture("jce6", keys = listOf("IMC"))
            val root = f.linkProgram()
            // A project of ANOTHER program of the same stream: under the stream, so only the root rule refuses it.
            val elsewhere = TestPlan.program(f.w.streamId, f.w.stranger.personId!!)
            val foreign = TestPlan.project(elsewhere, f.w.stranger.personId!!)
            val admin = f.w.admin.client
            val withProgram = JiraImportDefaults(programId = f.w.programId, teamId = f.defaultTeam)
            admin.preview(f.connectionId, f.scope(withProgram, root = root))
                .assertBadRequest("a default program", "defaults.programId cannot be combined with a root")
            admin.preview(f.connectionId, f.scope(JiraImportDefaults(projectId = foreign), root = root))
                .assertBadRequest("a foreign project", "defaults.projectId is not a project of the root program")
            // The apply refuses the same requests (before any browse or write), on the same words.
            val tick = listOf(createTick(imcId(2), JiraLevel.PROJECT, imcId(1)))
            admin.applyImport(f.connectionId, f.scope(JiraImportDefaults(projectId = foreign), root = root), tick)
                .assertBadRequest("apply, a foreign project", "not a project of the root program")
            // The root's owner does not own the foreign project: the guard on the named default is a 403, before the 400 ...
            val owner = f.w.programOwner.client
            val denied = owner.preview(f.connectionId, f.scope(JiraImportDefaults(projectId = foreign), root = root))
            assertEquals(HttpStatusCode.Forbidden, denied.status, denied.bodyAsText())
            // ... and a project nothing has is a 404 before either.
            val missing = owner.preview(f.connectionId, f.scope(JiraImportDefaults(projectId = 999_999u), root = root))
            assertEquals(HttpStatusCode.NotFound, missing.status, missing.bodyAsText())
            // A stranger is refused by the root's guard, whatever the defaults say.
            val stranger = f.w.stranger.client.preview(f.connectionId, f.scope(withProgram, root = root))
            assertEquals(HttpStatusCode.Forbidden, stranger.status, stranger.bodyAsText())
        }

    @Test
    fun `a project root takes neither defaults_programId nor defaults_projectId, and nothing was read from Jira`() = testApplication {
        val f = importFixture("jce7", keys = listOf("IMC"))
        val root = f.linkProject()
        val owner = f.w.projectOwner.client
        JiraStubServer.resetRequests()
        // The project's owner does not own the program (the guard on a named default would be a 403): the stream's owner does.
        f.w.streamOwner.client.preview(f.connectionId, f.scope(JiraImportDefaults(programId = f.w.programId), root = root))
            .assertBadRequest("a default program", "defaults.programId cannot be combined with a root")
        owner.preview(f.connectionId, f.scope(JiraImportDefaults(projectId = f.w.projectId), root = root))
            .assertBadRequest("the root's own project as a default", "defaults.projectId cannot be combined with a project root")
        val tick = listOf(createTick(imcId(5), JiraLevel.MILESTONE, imcId(2)))
        owner.applyImport(f.connectionId, f.scope(JiraImportDefaults(projectId = f.w.projectId), root = root), tick)
            .assertBadRequest("apply", "cannot be combined with a project root")
        assertEquals(emptyList(), stubSearches(), "a 400 of the shape is answered before the browse")
        // Without those defaults the same caller previews fine.
        val plain = owner.preview(f.connectionId, f.scope(JiraImportDefaults(teamId = f.defaultTeam), root = root))
        assertEquals(HttpStatusCode.OK, plain.status)
    }

    @Test
    fun `a rooted apply over more than 2000 children is a 400 that names the filter and, under a program root, a project below`() =
        testApplication {
            val f = importFixture("jce8", keys = listOf("IMC"))
            val admin = f.w.admin.client
            val docs = (1..2_001).map {
                val id = 200_000 + it
                issueDoc("$id", "IMC-$id", "10005", "Initiative", 2, fields = """"parent":{"id":"99001"}""")
            }
            val search = get(searchPattern).atPriority(1)
                .willReturn(
                    aResponse().withStatus(200).withHeader("Content-Type", "application/json").withBody(searchPage(*docs.toTypedArray())),
                )
            val revision = TestPlan.revision()
            val tick = listOf(createTick("200001", JiraLevel.PROJECT, imcId(1)))
            val program = f.linkProgram()
            val override = JiraStubServer.addOverride(search)
            try {
                val refused = admin.applyImport(f.connectionId, f.scope(root = program), tick)
                val detail = refused.jbProblem().detail.orEmpty()
                assertEquals(HttpStatusCode.BadRequest, refused.status, detail)
                assertTrue("narrow the filter" in detail && "start from a project below it" in detail && "projectKeys" !in detail, detail)
            } finally {
                JiraStubServer.removeOverride(override)
            }
            assertEquals(revision, TestPlan.revision(), "nothing was written")
            assertEquals(1, jbScalar("SELECT count(*) FROM jira_bindings WHERE connection_id = ?", f.connectionId.toInt()) { it.getInt(1) })
        }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
