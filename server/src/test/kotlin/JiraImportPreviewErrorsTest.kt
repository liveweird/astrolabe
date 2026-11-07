package ch.nokillswit

import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.jira.JiraConnectionResponse
import ch.nokillswit.jira.JiraConnectionServiceKey
import ch.nokillswit.jira.JiraImportAction
import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.browseGuard
import ch.nokillswit.jira.browseScope
import ch.nokillswit.jira.effectiveMapping
import com.github.tomakehurst.wiremock.client.MappingBuilder
import com.github.tomakehurst.wiremock.client.WireMock.aResponse
import com.github.tomakehurst.wiremock.client.WireMock.get
import com.github.tomakehurst.wiremock.client.WireMock.matching
import com.github.tomakehurst.wiremock.client.WireMock.urlPathMatching
import io.ktor.client.request.delete
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.server.plugins.BadRequestException
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * The refusals of `POST …/connections/{id}/import-preview`, in the plan's order, and the browse's own paths (the mapped `fields`, the
 * cap, a connection that goes away mid-read, an upstream failure). Every Jira call may be made to answer `503` ([failingJira]): the
 * journal is off, so "nothing was read from Jira" is proved by the outcome, a refusal that is not a `502`. One caller makes at most
 * five calls (the `jira-import` bucket); [freshAdmin] gives another.
 */
class JiraImportPreviewErrorsTest {
    private fun search(): MappingBuilder = get(urlPathMatching(".*/rest/api/3/search/jql")).atPriority(1)

    private inline fun <T> withOverride(stub: MappingBuilder, block: () -> T): T {
        val registered = JiraStubServer.addOverride(stub)
        try {
            return block()
        } finally {
            JiraStubServer.removeOverride(registered)
        }
    }

    private inline fun <T> failingJira(block: () -> T): T = withOverride(search().willReturn(aResponse().withStatus(503)), block)

    private fun problemType(body: String) = jbJson.decodeFromString<ch.nokillswit.plugins.ProblemDetail>(body)

    @Test
    fun `an unknown connection, work stream, default program or default project is a 404 before any guard`() = testApplication {
        val f = importFixture("jipe404")
        val admin = f.w.admin.client
        val gone = admin.jbConnection(jbRequest(keys = listOf("IMP")))
        assertEquals(HttpStatusCode.NoContent, admin.delete("$JB_CONNECTIONS/${gone.id}").status)
        failingJira {
            assertEquals(HttpStatusCode.NotFound, admin.preview(999_999u, f.scope()).status)
            assertEquals(HttpStatusCode.NotFound, admin.preview(gone.id, f.scope()).status, "a deleted connection")
            assertEquals(HttpStatusCode.NotFound, admin.preview(f.connectionId, f.scope().copy(workStreamId = 999_999u)).status)
            val program = admin.preview(f.connectionId, f.scope(JiraImportDefaults(programId = 999_999u)))
            assertEquals("Program not found", program.jbProblem().detail)
            val project = admin.preview(f.connectionId, f.scope(JiraImportDefaults(projectId = 999_999u)))
            assertEquals("Project not found", project.jbProblem().detail)
            // The 404 comes first for everyone: a stranger asking for a missing stream is told so, not refused.
            val missing = f.scope().copy(workStreamId = 999_999u)
            assertEquals(HttpStatusCode.NotFound, f.w.stranger.client.preview(f.connectionId, missing).status)
        }
    }

    @Test
    fun `a login that owns nothing, and an owner of a named default who does not own the other, are refused with 403 before the browse`() =
        testApplication {
            val f = importFixture("jipe403")
            failingJira {
                for ((name, caller) in f.w.outsiders) {
                    val refused = caller.client.preview(f.connectionId, f.scope())
                    assertEquals(HttpStatusCode.Forbidden, refused.status, name)
                }
                // 403 before 400: a stranger with a bad key subset is refused, not told about the key.
                assertEquals(HttpStatusCode.Forbidden, f.w.stranger.client.preview(f.connectionId, f.scope(keys = listOf("NOPE"))).status)
                // The project's owner names a default program they do not own.
                val named = f.w.projectOwner.client.preview(f.connectionId, f.scope(JiraImportDefaults(programId = f.w.programId)))
                assertEquals(HttpStatusCode.Forbidden, named.status)
            }
        }

    @Test
    fun `the shape is checked after the guards and before any read from Jira`() = testApplication {
        val f = importFixture("jipe400")
        val admin = f.w.admin.client
        val other = TestPlan.workStream(f.w.streamOwner.personId!!)
        val otherProgram = TestPlan.program(other, f.w.programOwner.personId!!)
        val otherProject = TestPlan.project(otherProgram, f.w.projectOwner.personId!!)
        failingJira {
            fun bad(response: HttpResponse, what: String) = assertEquals(HttpStatusCode.BadRequest, response.status, what)
            bad(admin.preview(f.connectionId, f.scope(keys = listOf("NOPE"))), "a key outside the connection")
            bad(admin.preview(f.connectionId, f.scope(keys = emptyList())), "no keys")
            bad(admin.preview(f.connectionId, f.scope(keys = listOf("IMP", "IMP"))), "a repeated key")
            bad(admin.preview(f.connectionId, f.scope(JiraImportDefaults(programId = otherProgram))), "a program of another stream")
            bad(admin.preview(f.connectionId, f.scope(JiraImportDefaults(projectId = otherProject))), "a project of another stream")
            val second = freshAdmin()
            bad(second.preview(f.connectionId, f.scope().copy(ownerPersonId = 999_999u)), "an unknown owner")
            bad(second.preview(f.connectionId, f.scope(JiraImportDefaults(teamId = 999_999u))), "an unknown default team")
            val raw = second.post("$JB_CONNECTIONS/${f.connectionId}/import-preview") {
                contentType(ContentType.Application.Json)
                setBody("{}")
            }
            bad(raw, "a body without the required members")
            jbSql("UPDATE jira_connections SET enabled = false WHERE id = ?", f.connectionId.toInt())
            val disabled = second.preview(f.connectionId, f.scope())
            bad(disabled, "a disabled connection")
            assertTrue("disabled" in disabled.jbProblem().detail.orEmpty())
        }
    }

    @Test
    fun `a connection never tested, an unreadable token and a mapping the site outgrew are 409 and nothing is read or rewritten`() =
        testApplication {
            val f = importFixture("jipe409")
            val admin = f.w.admin.client
            val created = admin.postJson(JB_CONNECTIONS, jbRequest(keys = listOf("IMP")))
            val untested = jbJson.decodeFromString<JiraConnectionResponse>(created.bodyAsText())
            val unreadable = admin.jbConnection(jbRequest(keys = listOf("IMP")))
            failingJira {
                val notDiscovered = admin.preview(untested.id, f.scope())
                assertEquals(HttpStatusCode.Conflict, notDiscovered.status)
                assertEquals("urn:astrolabe:problem:jira-not-discovered", notDiscovered.jbProblem().type)
                jbSql("UPDATE jira_connections SET api_token = 'enc:v1:not-a-real-envelope' WHERE id = ?", unreadable.id.toInt())
                val token = admin.preview(unreadable.id, f.scope())
                assertEquals(HttpStatusCode.Conflict, token.status)
                assertEquals("urn:astrolabe:problem:jira-token-unreadable", token.jbProblem().type)
                // Delete it (the token goes NULL) so the shared table keeps no undecryptable envelope for a later rotation test.
                assertEquals(HttpStatusCode.NoContent, admin.delete("$JB_CONNECTIONS/${unreadable.id}").status)
                val stale = """{"levels":{"milestone":{"hierarchyLevel":1,"fields":{"start":"customfield_99999"}}}}"""
                jbSql("UPDATE jira_connections SET mapping = ?::jsonb WHERE id = ?", stale, f.connectionId.toInt())
                val mapping = admin.preview(f.connectionId, f.scope())
                assertEquals(HttpStatusCode.Conflict, mapping.status)
                assertEquals("urn:astrolabe:problem:jira-mapping-invalid", mapping.jbProblem().type)
                val stored = jbScalar("SELECT mapping::text FROM jira_connections WHERE id = ?", f.connectionId.toInt()) { it.getString(1) }
                assertTrue("customfield_99999" in stored, "a refused preview rewrites nothing")
            }
        }

    @Test
    fun `an upstream failure is a typed 502 with the code only, and a body that is no listing is INVALID_RESPONSE`() = testApplication {
        val f = importFixture("jipe502")
        val admin = f.w.admin.client
        val root = LogCapture("ROOT")
        try {
            withOverride(search().willReturn(aResponse().withStatus(503))) {
                val outage = admin.preview(f.connectionId, f.scope())
                assertEquals(HttpStatusCode.BadGateway, outage.status)
                val body = outage.bodyAsText()
                assertEquals("urn:astrolabe:problem:jira-upstream", problemType(body).type)
                assertTrue("UPSTREAM_UNAVAILABLE" in body && f.token !in body)
            }
            withOverride(search().willReturn(aResponse().withStatus(200).withBody("""{"isLast":true}"""))) {
                val invalid = admin.preview(f.connectionId, f.scope())
                assertEquals(HttpStatusCode.BadGateway, invalid.status)
                assertTrue("INVALID_RESPONSE" in invalid.bodyAsText())
            }
            assertTrue(root.events.none { f.token in it.formattedMessage }, "the token never reaches a log line")
        } finally {
            root.detach()
        }
    }

    @Test
    fun `the bucket is 5 a minute per user, spent before everything else, and another user is not affected`() = testApplication {
        val f = importFixture("jipe429")
        val limited = freshAdmin()
        failingJira {
            repeat(5) { assertEquals(HttpStatusCode.NotFound, limited.preview(999_999u, f.scope()).status) }
            // A real connection would be answered; the limiter is first.
            assertEquals(HttpStatusCode.TooManyRequests, limited.preview(f.connectionId, f.scope()).status)
            assertEquals(HttpStatusCode.TooManyRequests, limited.preview(999_999u, f.scope()).status)
            assertEquals(HttpStatusCode.BadGateway, f.w.admin.client.preview(f.connectionId, f.scope()).status, "another user's bucket")
        }
    }

    @Test
    fun `the browse asks for the mapped date, estimate and Team fields of the connection's scope`() = testApplication {
        val f = importFixture("jipefld")
        // The journal is off: the override only matches a request whose `fields` names all four mapped ids (Target start/end, story points,
        // the Team field), whose `jql` is the typed full read, and answers one marker issue. Any other request gets the stub's IMP page.
        val wanted = matching("(?=.*customfield_10022)(?=.*customfield_10023)(?=.*customfield_10026)(?=.*customfield_10001).*")
        val marker = search().withQueryParam("fields", wanted).withQueryParam("jql", matching(".*issuetype in \\(.*\\) ORDER BY id ASC"))
            .willReturn(aResponse().withStatus(200).withBody(searchPage(issueDoc("99999", "IMP-77", level = 1))))
        withOverride(marker) {
            val preview = f.w.admin.client.preview(f.connectionId, f.scope()).previewBody()
            assertEquals(listOf("IMP-77"), preview.items.map { it.issueKey })
        }
    }

    @Test
    fun `more than 2,000 issues in scope is truncated to the lowest 2,000 ids and reported`() = testApplication {
        val f = importFixture("jipetrunc")
        val padding = "x".repeat(80)
        val docs = (1..2_001).map {
            val type = """{"id":"10004","name":"Epic","hierarchyLevel":1}"""
            """{"id":"${100_000 + it}","key":"IMP-$it","fields":{"summary":"$padding $it","issuetype":$type}}"""
        }
        withOverride(search().willReturn(aResponse().withStatus(200).withBody(searchPage(*docs.toTypedArray())))) {
            val preview = f.w.admin.client.preview(f.connectionId, f.scope()).previewBody()
            assertEquals(2_000, preview.items.size)
            assertTrue(preview.totals.truncated)
            assertEquals(2_000, preview.totals.items)
            assertTrue(preview.items.none { it.issueKey == "IMP-2001" }, "the lowest ids are kept")
            assertTrue(preview.items.all { it.action == JiraImportAction.SKIP }, "no parent in scope and no default project")
        }
    }

    @Test
    fun `a connection disabled or deleted during the read stops the browse at the next page's stop with a typed 400 or 404`() =
        testApplication {
            val f = importFixture("jipemid")
            val connections = application.attributes[JiraConnectionServiceKey]
            val admin = f.w.admin.client
            for (disable in listOf(true, false)) {
                val connection = admin.jbConnection(jbRequest(f.site, keys = listOf("IMP")))
                val context = checkNotNull(connections.readForBind(connection.id))
                val discovery = checkNotNull(context.state.discovery)
                // The row flips while page 1 is being answered: the stop that precedes page 2 must be the one that ends the read.
                val site = ScriptedSite(
                    searchPage(issueDoc("99999", "IMP-77", level = 1), next = "T2"), searchPage(issueDoc("99998", "IMP-78", level = 1)),
                    onSearch = { index ->
                        if (index == 0 && disable) jbSql("UPDATE jira_connections SET enabled = false WHERE id = ?", connection.id.toInt())
                        if (index == 0 && !disable) {
                            assertEquals(HttpStatusCode.NoContent, admin.delete("$JB_CONNECTIONS/${connection.id}").status)
                        }
                    },
                )
                val stop = browseGuard(connections, connection.id)
                val run = suspend {
                    browseScope(
                        site.connector, context, checkNotNull(context.target.apiToken), listOf("IMP"),
                        effectiveMapping(context.state, discovery), discovery, 1L, stop,
                    )
                }
                if (disable) {
                    val failure = assertFailsWith<BadRequestException> { run() }
                    assertTrue("disabled" in failure.message.orEmpty(), failure.message)
                } else {
                    assertFailsWith<NotFoundException> { run() }
                }
                assertEquals(1, site.searches.size, "page 2 was never requested")
            }
        }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
