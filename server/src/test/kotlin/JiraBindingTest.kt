package ch.nokillswit

import ch.nokillswit.jira.JiraBindingResponse
import ch.nokillswit.jira.JiraLevel
import com.github.tomakehurst.wiremock.client.MappingBuilder
import com.github.tomakehurst.wiremock.client.WireMock.aResponse
import com.github.tomakehurst.wiremock.client.WireMock.get
import com.github.tomakehurst.wiremock.client.WireMock.urlPathMatching
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `POST /api/v1/integrations/jira/bindings` against the shared [JiraStubServer]: the caller matrix per level, the 404 -> 403 -> 400
 * order, every pre-flight refusal, the first observation and the over-limit clamps. The stub's `E2E` project: `E2E-1` Program,
 * `E2E-2`/`E2E-3` Initiatives, `E2E-4`..`E2E-10` Epics (`E2E-5`: 2044-02-01..02-10, 8 story points, team "E2E Team"). Every test binds on a
 * PRIVATE site ([jbSite]): bindings are 1:1 per site, and the suite shares its database.
 */
class JiraBindingTest {
    private suspend fun ApplicationTestBuilder.start() {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
    }

    private class Fixture(val w: PlanWorld, val connectionId: UInt, val site: String) {
        val teamId get() = w.requireTeams().teamId

        suspend fun milestone(name: String = planName("ms")) = TestPlan.milestone(w.projectId, teamId, name)

        fun node(level: JiraLevel): UInt = when (level) {
            JiraLevel.PROGRAM -> w.programId
            JiraLevel.PROJECT -> w.projectId
            JiraLevel.MILESTONE -> error("a milestone is created per use")
        }
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        start()
        val w = planWorld(prefix, teams = true)
        val request = jbRequest()
        return Fixture(w, w.admin.client.jbConnection(request).id, request.siteUrl)
    }

    private inline fun <T> withOverride(stub: MappingBuilder, block: () -> T): T {
        val registered = JiraStubServer.addOverride(stub)
        try {
            return block()
        } finally {
            JiraStubServer.removeOverride(registered)
        }
    }

    /** Every Jira call (the tenant lookup and any issue read) answers 503 while [block] runs. */
    private inline fun <T> failingJira(block: () -> T): T {
        val down = aResponse().withStatus(503)
        return withOverride(get(urlPathMatching("/_edge/tenant_info")).atPriority(1).willReturn(down)) {
            withOverride(get(urlPathMatching(".*/rest/api/3/issue/.*")).atPriority(1).willReturn(down), block)
        }
    }

    private fun issuePath(key: String) = get(urlPathMatching(".*/rest/api/3/issue/$key")).atPriority(1)

    // --- the caller matrix and the order of the rules ----------------------------------------------------------------------------

    @Test
    fun `the owner chain and ADMIN link a node at every level - a stranger, a person-less login, an editor and a team manager get 403`() =
        testApplication {
            val f = fixture("jbmatrix")
            val w = f.w
            val teams = w.requireTeams()
            val milestone = f.milestone()
            val aboveProject = listOf("admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner)
            val cases = listOf(
                Triple(JiraLevel.PROGRAM, "E2E-1", aboveProject),
                Triple(JiraLevel.PROJECT, "E2E-2", aboveProject + ("project owner" to w.projectOwner)),
                Triple(JiraLevel.MILESTONE, "E2E-4", aboveProject + ("project owner" to w.projectOwner)),
            )
            val outsiders = listOf(
                "stranger" to w.stranger, "personless" to w.personless, "editor" to w.editor,
                "team manager" to teams.manager, "other team manager" to teams.otherManager,
            )
            for ((level, key, allowed) in cases) {
                val node = if (level == JiraLevel.MILESTONE) milestone else f.node(level)
                val denied = outsiders + if (level == JiraLevel.PROGRAM) listOf("project owner" to w.projectOwner) else emptyList()
                for ((who, caller) in denied) {
                    val valid = caller.client.jbBind(f.connectionId, level, node, key)
                    assertEquals(HttpStatusCode.Forbidden, valid.status, "$who must not link a $level")
                    val invalid = caller.client.jbBind(f.connectionId, level, node, "not a key")
                    assertEquals(HttpStatusCode.Forbidden, invalid.status, "$who: 403 beats the key's 400")
                }
                for ((who, caller) in allowed) {
                    val binding = caller.client.jbBind(f.connectionId, level, node, key).jbBinding()
                    assertEquals(level, binding.node.kind, who)
                    assertEquals(node, binding.node.id, who)
                    // Recycles the issue and the node for the next caller; the unbinder is an owner of the same chain.
                    assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("$JB_BINDINGS/${binding.id}").status)
                }
            }
        }

    @Test
    fun `an unknown or deleted node is 404 for every caller, a forbidden caller's bad key stays 403 and an owner's is 400`() =
        testApplication {
            val f = fixture("jborder")
            val w = f.w
            for (level in JiraLevel.entries) {
                for ((who, caller) in listOf("admin" to w.admin, "stranger" to w.stranger, "personless" to w.personless)) {
                    val status = caller.client.jbBind(f.connectionId, level, 999_999u, "not a key").status
                    assertEquals(HttpStatusCode.NotFound, status, "$who, $level: the node is resolved first")
                }
            }
            val gone = f.milestone()
            assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$gone").status)
            assertEquals(HttpStatusCode.NotFound, w.projectOwner.client.jbBind(f.connectionId, JiraLevel.MILESTONE, gone, "E2E-4").status)
            // An owner passes the guard; only then do the 400s apply.
            val owner = w.projectOwner.client
            assertEquals(HttpStatusCode.BadRequest, owner.jbBind(f.connectionId, JiraLevel.PROJECT, w.projectId, "not a key").status)
            assertEquals(HttpStatusCode.BadRequest, owner.jbBind(f.connectionId, JiraLevel.PROJECT, w.projectId, "e2e-2").status)
            val unknownConnection = owner.jbBind(999_999u, JiraLevel.PROJECT, w.projectId, "E2E-2")
            assertEquals(HttpStatusCode.BadRequest, unknownConnection.status, "unknown connection")
            // The body is decoded before the node is known, so an undecodable one is a 400 for everybody (no node was addressed).
            for (caller in listOf(w.admin, w.stranger)) {
                for (body in listOf("{ not json", """{"connectionId":1,"level":"TEAM","nodeId":1,"issueKey":"E2E-2"}""", "{}")) {
                    val response = caller.client.post(JB_BINDINGS) {
                        contentType(ContentType.Application.Json)
                        setBody(body)
                    }
                    assertEquals(HttpStatusCode.BadRequest, response.status, body)
                }
            }
        }

    @Test
    fun `a disabled or deleted connection and one never tested are refused before anything is read from Jira`() = testApplication {
        val f = fixture("jbconn")
        val admin = f.w.admin.client
        val node = f.milestone()
        val request = jbRequest(f.site)
        // Disabled: PUT is a full replace and keeps the stored token.
        val disabled = admin.jbConnection(request.copy(name = "jb-disabled-${System.nanoTime()}", enabled = true))
        val replaced = request.copy(name = disabled.name, apiToken = null, enabled = false)
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$JB_CONNECTIONS/${disabled.id}", replaced).status)
        val untested = admin.postJson(JB_CONNECTIONS, jbRequest(jbSite()))
        val untestedId = jbJson.decodeFromString<ch.nokillswit.jira.JiraConnectionResponse>(untested.bodyAsText()).id
        // The journal is off, so "nothing was read from Jira" is proved by the outcome: with EVERY Jira call answering 503, a bind that
        // reached the site would be a 502; each refusal below is a 400/409 from the pre-flight alone.
        failingJira {
            val refusal = admin.jbBind(disabled.id, JiraLevel.MILESTONE, node, "E2E-4")
            assertEquals(HttpStatusCode.BadRequest, refusal.status)
            assertTrue("Unknown or disabled Jira connection" in refusal.jbProblem().detail.orEmpty())
            // Deleted.
            assertEquals(HttpStatusCode.NoContent, admin.delete("$JB_CONNECTIONS/${disabled.id}").status)
            assertEquals(HttpStatusCode.BadRequest, admin.jbBind(disabled.id, JiraLevel.MILESTONE, node, "E2E-4").status)
            // Never tested: no discovery.
            val notDiscovered = admin.jbBind(untestedId, JiraLevel.MILESTONE, node, "E2E-4")
            assertEquals(HttpStatusCode.Conflict, notDiscovered.status)
            assertEquals("urn:astrolabe:problem:jira-not-discovered", notDiscovered.jbProblem().type)
            // A token the key can no longer decrypt.
            jbSql("UPDATE jira_connections SET api_token = 'enc:v1:not-a-real-envelope' WHERE id = ?", f.connectionId.toInt())
            val unreadable = admin.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-4")
            assertEquals(HttpStatusCode.Conflict, unreadable.status)
            assertEquals("urn:astrolabe:problem:jira-token-unreadable", unreadable.jbProblem().type)
            // Delete it (the token goes NULL) so the shared table keeps no undecryptable envelope for a later rotation test.
            assertEquals(HttpStatusCode.NoContent, admin.delete("$JB_CONNECTIONS/${f.connectionId}").status)
        }
        assertEquals(0, jbScalar("SELECT count(*) FROM jira_bindings WHERE milestone_id = ?", node.toInt()) { it.getInt(1) })
    }

    @Test
    fun `binding rides a per-user bucket of 30 a minute that runs before the guard, and another user is not affected`() = testApplication {
        val f = fixture("jbbucket")
        val w = f.w
        val node = f.milestone()
        repeat(30) {
            assertEquals(HttpStatusCode.NotFound, w.stranger.client.jbBind(f.connectionId, JiraLevel.MILESTONE, 999_999u, "E2E-4").status)
        }
        // The 31st would be a 403 for this stranger on a real node: the limiter answers first, so a refused caller cannot enumerate.
        val limited = w.stranger.client.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-4")
        assertEquals(HttpStatusCode.TooManyRequests, limited.status)
        val again = w.stranger.client.jbBind(f.connectionId, JiraLevel.MILESTONE, 999_999u, "E2E-4")
        assertEquals(HttpStatusCode.TooManyRequests, again.status)
        // Keyed by the verified user, not the address: everyone else binds, and the limited user's reads and unbinds are not bound.
        w.projectOwner.client.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-4").jbBinding()
        assertEquals(HttpStatusCode.OK, w.stranger.client.get(JB_BINDINGS).status)
    }

    // --- what the issue must be ----------------------------------------------------------------------------------------------------

    @Test
    fun `the issue's hierarchy level must be the mapping's level for the plan level - the message names both`() = testApplication {
        val f = fixture("jblevel")
        val admin = f.w.admin.client
        val milestone = f.milestone()
        val epicOnProgram = admin.jbBind(f.connectionId, JiraLevel.PROGRAM, f.w.programId, "E2E-5")
        assertEquals(HttpStatusCode.BadRequest, epicOnProgram.status)
        val epicDetail = epicOnProgram.jbProblem().detail.orEmpty()
        assertTrue("E2E-5 is at level 1 (Epic); programs map to level 3 (Program)" in epicDetail, epicDetail)
        val initiativeOnMilestone = admin.jbBind(f.connectionId, JiraLevel.MILESTONE, milestone, "E2E-2")
        assertEquals(HttpStatusCode.BadRequest, initiativeOnMilestone.status)
        val initiativeDetail = initiativeOnMilestone.jbProblem().detail.orEmpty()
        assertTrue("E2E-2 is at level 2 (Initiative); milestones map to level 1 (Epic)" in initiativeDetail)
        // An issue whose type the site did not number: refused the same way, never bound blind.
        withOverride(
            issuePath("E2E-5").willReturn(
                aResponse().withStatus(200)
                    .withBody("""{"id":"90005","key":"E2E-5","fields":{"summary":"x","issuetype":{"id":"99999","name":"Odd"}}}"""),
            ),
        ) {
            val unknown = admin.jbBind(f.connectionId, JiraLevel.MILESTONE, milestone, "E2E-5")
            assertEquals(HttpStatusCode.BadRequest, unknown.status)
            assertTrue("an unknown level" in unknown.jbProblem().detail.orEmpty())
        }
        // The same connection maps projects too: an Initiative binds a project, a Program a program.
        admin.jbBind(f.connectionId, JiraLevel.PROJECT, f.w.projectId, "E2E-2").jbBinding()
        admin.jbBind(f.connectionId, JiraLevel.PROGRAM, f.w.programId, "E2E-1").jbBinding()
    }

    @Test
    fun `the issue must be in the connection's project keys and must exist`() = testApplication {
        val f = fixture("jbscope")
        val admin = f.w.admin.client
        val node = f.milestone()
        for (outside in listOf("OUT-1", "CE-1", "ZZZ-9")) {
            val response = admin.jbBind(f.connectionId, JiraLevel.MILESTONE, node, outside)
            assertEquals(HttpStatusCode.BadRequest, response.status, outside)
            assertTrue("$outside is outside the connection's project keys" in response.jbProblem().detail.orEmpty())
        }
        val unknown = admin.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-99")
        assertEquals(HttpStatusCode.BadRequest, unknown.status)
        assertTrue("Unknown Jira issue: E2E-99" in unknown.jbProblem().detail.orEmpty())
        // A moved issue answers under its new key: that project must be in scope too.
        withOverride(
            issuePath("E2E-5").willReturn(
                aResponse().withStatus(200).withBody(
                    """{"id":"90005","key":"OUT-1","fields":{"summary":"x","issuetype":{"id":"10000","name":"Epic","hierarchyLevel":1}}}""",
                ),
            ),
        ) {
            val moved = admin.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-5")
            assertEquals(HttpStatusCode.BadRequest, moved.status)
        }
        assertEquals(0, jbScalar("SELECT count(*) FROM jira_bindings WHERE milestone_id = ?", node.toInt()) { it.getInt(1) })
    }

    @Test
    fun `an upstream failure is a typed 502 with the code only and nothing is bound`() = testApplication {
        val f = fixture("jb502")
        val admin = f.w.admin.client
        val node = f.milestone()
        withOverride(issuePath("E2E-5").willReturn(aResponse().withStatus(503))) {
            val outage = admin.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-5")
            assertEquals(HttpStatusCode.BadGateway, outage.status)
            val problem = outage.jbProblem()
            assertEquals("urn:astrolabe:problem:jira-upstream", problem.type)
            assertTrue("UPSTREAM_UNAVAILABLE" in problem.detail.orEmpty())
        }
        withOverride(issuePath("E2E-5").willReturn(aResponse().withStatus(200).withBody("""{"id":"x","key":"E2E-5","fields":{}}"""))) {
            val invalid = admin.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-5")
            assertEquals(HttpStatusCode.BadGateway, invalid.status)
            assertTrue("INVALID_RESPONSE" in invalid.jbProblem().detail.orEmpty())
        }
        assertEquals(0, jbScalar("SELECT count(*) FROM jira_bindings WHERE milestone_id = ?", node.toInt()) { it.getInt(1) })
    }

    // --- the stored mapping against the current discovery ---------------------------------------------------------------------------

    @Test
    fun `a stored mapping the site's discovery has outgrown is a 409 jira-mapping-invalid - never bound through, never rewritten`() =
        testApplication {
            val f = fixture("jbstale")
            val admin = f.w.admin.client
            val node = f.milestone()
            val stale = """{"levels":{"milestone":{"hierarchyLevel":1,"fields":{"start":"customfield_99999"}}}}"""
            jbSql("UPDATE jira_connections SET mapping = ?::jsonb WHERE id = ?", stale, f.connectionId.toInt())
            val refused = admin.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-5")
            assertEquals(HttpStatusCode.Conflict, refused.status)
            val problem = refused.jbProblem()
            assertEquals("urn:astrolabe:problem:jira-mapping-invalid", problem.type)
            assertTrue("customfield_99999" in problem.detail.orEmpty() && "administrator" in problem.detail.orEmpty(), problem.detail)
            // A level the site no longer has.
            val noSuchLevel = """{"levels":{"milestone":{"hierarchyLevel":7}}}"""
            jbSql("UPDATE jira_connections SET mapping = ?::jsonb WHERE id = ?", noSuchLevel, f.connectionId.toInt())
            assertEquals(HttpStatusCode.Conflict, admin.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-5").status)
            // A document this build cannot decode.
            jbSql("""UPDATE jira_connections SET mapping = '{"levels":5}'::jsonb WHERE id = ?""", f.connectionId.toInt())
            assertEquals(HttpStatusCode.Conflict, admin.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-5").status)
            val stored = jbScalar("SELECT mapping::text FROM jira_connections WHERE id = ?", f.connectionId.toInt()) { it.getString(1) }
            assertEquals("""{"levels": 5}""", stored, "a refused bind rewrites nothing")
            assertEquals(0, jbScalar("SELECT count(*) FROM jira_bindings WHERE milestone_id = ?", node.toInt()) { it.getInt(1) })
            // Fixed: the same bind goes through.
            jbSql("UPDATE jira_connections SET mapping = '{}'::jsonb WHERE id = ?", f.connectionId.toInt())
            admin.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-5").jbBinding()
        }

    @Test
    fun `a level the mapping leaves out cannot be bound`() = testApplication {
        val f = fixture("jbnolevel")
        val admin = f.w.admin.client
        val mapping = """{"levels":{"milestone":{"hierarchyLevel":1,"fields":{"start":"customfield_10022","end":"customfield_10023"}}}}"""
        jbSql("UPDATE jira_connections SET mapping = ?::jsonb WHERE id = ?", mapping, f.connectionId.toInt())
        val response = admin.jbBind(f.connectionId, JiraLevel.PROJECT, f.w.projectId, "E2E-2")
        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertTrue("does not map projects" in response.jbProblem().detail.orEmpty())
        admin.jbBind(f.connectionId, JiraLevel.MILESTONE, f.milestone(), "E2E-5").jbBinding()
    }

    // --- the first observation ---------------------------------------------------------------------------------------------------------

    @Test
    fun `a gone observation reads OUT_OF_SCOPE until a probe answered, then MOVED_OUT or NOT_LISTED`() = testApplication {
        val f = fixture("jbmoved")
        val admin = f.w.admin.client
        val binding = admin.jbBind(f.connectionId, JiraLevel.MILESTONE, f.milestone(), "E2E-5").jbBinding()
        suspend fun reason() = assertNotNull(
            jbJson.decodeFromString<JiraBindingResponse>(admin.get("$JB_BINDINGS/${binding.id}").bodyAsText()).observation,
        ).goneReason
        val id = binding.id.toInt()
        jbSql("UPDATE jira_observations SET gone = TRUE, gone_reason = 'OUT_OF_SCOPE', gone_probed_at = NULL WHERE binding_id = ?", id)
        assertEquals("OUT_OF_SCOPE", reason(), "the sweep's verdict, no probe answer yet")
        jbSql("UPDATE jira_observations SET gone_probed_at = 5 WHERE binding_id = ?", id)
        assertEquals("MOVED_OUT", reason(), "the probe's 200 that kept no key: 1.12's inference")
        jbSql("UPDATE jira_observations SET gone_probed_key = 'OUT-3' WHERE binding_id = ?", id)
        assertEquals("MOVED_OUT", reason(), "a key outside the connection's keys (E2E)")
        jbSql("UPDATE jira_observations SET gone_probed_key = 'E2E-9' WHERE binding_id = ?", id)
        assertEquals("NOT_LISTED", reason(), "a key inside them: Jira has it where the connection looks, the listing does not")
        assertEquals(
            "OUT_OF_SCOPE", jbScalar("SELECT gone_reason FROM jira_observations WHERE binding_id = ?", id) { it.getString(1) },
            "derived on read: the column is untouched",
        )
        jbSql("UPDATE jira_observations SET gone_reason = 'FORBIDDEN' WHERE binding_id = ?", id)
        assertEquals("FORBIDDEN", reason(), "a probe's 403 verdict is stored as it is, whatever key is left")
    }

    @Test
    fun `a bind stores the binding and its first observation read through the mapping`() = testApplication {
        val f = fixture("jbobs")
        val name = planName("Épic Mílestone")
        val node = f.milestone(name)
        val before = System.currentTimeMillis()
        val created = f.w.projectOwner.client.jbBind(f.connectionId, JiraLevel.MILESTONE, node, " E2E-5 ")
        val binding = created.jbBinding()
        assertEquals("$JB_BINDINGS/${binding.id}", created.headers[io.ktor.http.HttpHeaders.Location], "Location points at the new binding")
        assertEquals("E2E-5", binding.issueKey)
        assertEquals("90005", binding.issueId)
        assertEquals("${f.site}/browse/E2E-5", binding.url)
        assertEquals(JiraLevel.MILESTONE, binding.level)
        assertEquals(name, binding.node.name)
        assertNotNull(binding.node.projectName)
        assertNotNull(binding.node.programName)
        assertNotNull(binding.node.workStreamName)
        val creator = assertNotNull(binding.createdBy)
        assertEquals(f.w.projectOwner.userId, creator.userId)
        val observation = assertNotNull(binding.observation)
        assertTrue(observation.observedAt >= before)
        assertEquals("E2E-5", observation.issueKey)
        assertEquals("E2E Epic Two", observation.summary)
        assertEquals(1, observation.hierarchyLevel)
        assertEquals("2044-02-01", observation.startDate)
        assertEquals("2044-02-10", observation.endDate)
        assertEquals(8.0, observation.estimate)
        assertEquals(ch.nokillswit.jira.JiraEstimateUnit.POINTS, observation.estimateUnit)
        assertEquals("E2E Team", observation.teamName)
        assertEquals("E2E-2", observation.parentIssueKey)
        assertEquals("90002", observation.parentIssueId)
        assertEquals(false, observation.gone)
        assertNull(observation.goneReason)
        assertNotNull(observation.jiraUpdatedAt)
        assertEquals(1, jbScalar("SELECT count(*) FROM jira_observations WHERE binding_id = ?", binding.id.toInt()) { it.getInt(1) })
        // A binding is not plan state: no revision moved, the plan read it as it was.
        val revision = TestPlan.revision()
        f.w.admin.client.delete("$JB_BINDINGS/${binding.id}")
        assertEquals(revision, TestPlan.revision())
        val again = f.w.admin.client.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-5").jbBinding()
        assertEquals(revision, TestPlan.revision(), "a bind bumps no plan revision")
        assertEquals(1, jbScalar("SELECT count(*) FROM jira_observations WHERE binding_id = ?", again.id.toInt()) { it.getInt(1) })
    }

    @Test
    fun `an over-limit value from the site is clamped, never a failed bind`() = testApplication {
        val f = fixture("jbclamp")
        val node = f.milestone()
        val summary = "S".repeat(400)
        val team = "T".repeat(300) + "😀"
        val type = """{"id":"10000","name":"${"Y".repeat(200)}","hierarchyLevel":1}"""
        val status = """{"name":"${"Z".repeat(200)}","statusCategory":{"key":"indeterminate"}}"""
        val body = """{"id":"90005","key":"E2E-5","fields":{"summary":"$summary","issuetype":$type,"status":$status,
            "customfield_10001":{"name":"$team"},"customfield_10026":1e12,"customfield_10022":"2044-02-01",
            "customfield_10023":"2044-02-10","updated":"2026-10-26T10:11:12.000+0000"}}"""
        withOverride(issuePath("E2E-5").willReturn(aResponse().withStatus(200).withBody(body))) {
            val binding = f.w.admin.client.jbBind(f.connectionId, JiraLevel.MILESTONE, node, "E2E-5").jbBinding()
            val observation = assertNotNull(binding.observation)
            assertEquals(255, observation.summary?.length)
            assertEquals(100, observation.teamName?.length)
            assertEquals(100, observation.typeName?.length)
            assertEquals(100, observation.statusName?.length)
            assertNull(observation.estimate, "1e12 does not fit NUMERIC(12,2): not observed")
            assertEquals(ch.nokillswit.jira.JiraStatusCategory.IN_PROGRESS, observation.statusCategory)
            assertEquals("2044-02-01", observation.startDate)
            assertNotNull(observation.jiraUpdatedAt)
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
