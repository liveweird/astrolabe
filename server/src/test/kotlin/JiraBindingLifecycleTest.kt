package ch.nokillswit

import ch.nokillswit.jira.JiraBindingResponse
import ch.nokillswit.jira.JiraLevel
import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * What happens to a binding after it is made (unbind, the 1:1 rules, the inline release of a dead node's binding, the connection delete
 * that unbinds with it) and how it is read (the paged list, `q`, the single GET), with the audit trail. Stub facts: `JiraBindingTest`.
 */
class JiraBindingLifecycleTest {
    private suspend fun ApplicationTestBuilder.start() {
        configureApp("jira.stubBaseUrl" to JiraStubFixture.warm(), "jira.maxRetries" to "0")
        startApplication()
    }

    private class Fixture(val w: PlanWorld, val connectionId: UInt, val site: String, val token: String) {
        suspend fun milestone(name: String = planName("ms")) = TestPlan.milestone(w.projectId, w.requireTeams().teamId, name)
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        start()
        val w = planWorld(prefix, teams = true)
        val request = jbRequest()
        return Fixture(w, w.admin.client.jbConnection(request).id, request.siteUrl, checkNotNull(request.apiToken))
    }

    private suspend fun HttpClient.bindMilestone(connectionId: UInt, node: UInt, key: String) =
        jbBind(connectionId, JiraLevel.MILESTONE, node, key).jbBinding()

    // --- unbind ---------------------------------------------------------------------------------------------------------------------

    @Test
    fun `unbinding frees both sides, is audited, and only the chain's owners and ADMIN may do it - 404 before 403`() = testApplication {
        val f = fixture("jbunbind")
        val w = f.w
        val node = f.milestone()
        val binding = w.projectOwner.client.bindMilestone(f.connectionId, node, "E2E-5")
        val url = "$JB_BINDINGS/${binding.id}"
        val denied = listOf(
            "stranger" to w.stranger, "personless" to w.personless, "editor" to w.editor, "team manager" to w.requireTeams().manager,
        )
        for ((who, caller) in denied) {
            assertEquals(HttpStatusCode.Forbidden, caller.client.delete(url).status, who)
        }
        assertEquals(HttpStatusCode.NotFound, w.stranger.client.delete("$JB_BINDINGS/999999").status, "404 for every caller")
        assertTrue(jbActive(binding.id))
        withAuditCapture { audit ->
            assertEquals(HttpStatusCode.NoContent, w.programOwner.client.delete(url).status)
            val event = assertNotNull(
                audit.awaitEvent { it.message == "jira.binding_deleted" && it.hasKeyValue("bindingId", binding.id.toLong()) },
            )
            assertTrue(event.hasKeyValue("byUserId", w.programOwner.userId.toLong()))
            assertTrue(event.hasKeyValue("connectionId", f.connectionId.toLong()))
            assertTrue(event.hasKeyValue("level", "MILESTONE") && event.hasKeyValue("nodeId", node.toLong()))
            assertTrue(event.hasKeyValue("issueId", "90005") && event.hasKeyValue("issueKey", "E2E-5"))
        }
        assertFalse(jbActive(binding.id), "a soft delete: the row stays as history")
        assertEquals(HttpStatusCode.NotFound, w.admin.client.get(url).status)
        assertEquals(HttpStatusCode.NotFound, w.admin.client.delete(url).status, "already unbound")
        // Both sides are free again.
        w.admin.client.bindMilestone(f.connectionId, node, "E2E-7")
        w.admin.client.bindMilestone(f.connectionId, f.milestone(), "E2E-5")
    }

    @Test
    fun `a binding whose node was deleted is unbound by whoever passes the guard on the chain the node had`() = testApplication {
        val f = fixture("jbdead")
        val w = f.w
        val node = f.milestone()
        val binding = w.admin.client.bindMilestone(f.connectionId, node, "E2E-5")
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/milestones/$node").status)
        // Gone from the reads, still there to unbind.
        assertEquals(HttpStatusCode.NotFound, w.admin.client.get("$JB_BINDINGS/${binding.id}").status)
        assertTrue(jbActive(binding.id))
        assertEquals(HttpStatusCode.Forbidden, w.stranger.client.delete("$JB_BINDINGS/${binding.id}").status)
        assertEquals(HttpStatusCode.Forbidden, w.requireTeams().manager.client.delete("$JB_BINDINGS/${binding.id}").status)
        assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.delete("$JB_BINDINGS/${binding.id}").status)
        assertFalse(jbActive(binding.id))
    }

    // --- 1:1, D1, the inline release ----------------------------------------------------------------------------------------------

    @Test
    fun `both sides of a binding are exclusive - the 409s name the other side`() = testApplication {
        val f = fixture("jb409")
        val admin = f.w.admin.client
        val first = f.milestone(planName("First"))
        val second = f.milestone(planName("Second"))
        admin.bindMilestone(f.connectionId, first, "E2E-5")
        val nodeTaken = admin.jbBind(f.connectionId, JiraLevel.MILESTONE, first, "E2E-7")
        assertEquals(HttpStatusCode.Conflict, nodeTaken.status)
        val nodeProblem = nodeTaken.jbProblem()
        assertEquals("urn:astrolabe:problem:already-bound", nodeProblem.type)
        assertTrue(Regex("Milestone First-.* is already linked to E2E-5").containsMatchIn(nodeProblem.detail.orEmpty()), nodeProblem.detail)
        val issueTaken = admin.jbBind(f.connectionId, JiraLevel.MILESTONE, second, "E2E-5")
        assertEquals(HttpStatusCode.Conflict, issueTaken.status)
        val issueProblem = issueTaken.jbProblem()
        assertEquals("urn:astrolabe:problem:already-bound", issueProblem.type)
        assertTrue(Regex("E2E-5 is already linked to milestone First-").containsMatchIn(issueProblem.detail.orEmpty()), issueProblem.detail)
        assertEquals(1, jbActiveOnSite(f.site, "90005"))
        // The owner of the chain gets the same answers (the node's name is already public to every reader of the plan).
        assertEquals(HttpStatusCode.Conflict, f.w.projectOwner.client.jbBind(f.connectionId, JiraLevel.MILESTONE, second, "E2E-5").status)
    }

    @Test
    fun `D1 - one Jira item is linked once per site, whatever the connection`() = testApplication {
        val f = fixture("jbd1")
        val admin = f.w.admin.client
        val other = admin.jbConnection(jbRequest(f.site))
        val elsewhere = admin.jbConnection(jbRequest())
        val first = f.milestone()
        val second = f.milestone()
        admin.bindMilestone(f.connectionId, first, "E2E-5")
        val refused = admin.jbBind(other.id, JiraLevel.MILESTONE, second, "E2E-5")
        assertEquals(HttpStatusCode.Conflict, refused.status, "the same issue through another connection of the same site")
        assertEquals("urn:astrolabe:problem:already-bound", refused.jbProblem().type)
        // Another site is another Jira: the same numeric id there is a different item.
        admin.bindMilestone(elsewhere.id, second, "E2E-5")
        // A free issue through the other connection of the site is fine, and the node rule still applies across connections.
        val third = f.milestone()
        admin.bindMilestone(other.id, third, "E2E-7")
        assertEquals(HttpStatusCode.Conflict, admin.jbBind(other.id, JiraLevel.MILESTONE, first, "E2E-8").status, "the node is taken")
        // A deleted connection of the site does not hold the issue (D2).
        assertEquals(HttpStatusCode.NoContent, admin.delete("$JB_CONNECTIONS/${f.connectionId}").status)
        admin.bindMilestone(other.id, f.milestone(), "E2E-5")
        assertEquals(1, jbActiveOnSite(f.site, "90005"))
    }

    @Test
    fun `a conflicting binding whose node was deleted is released inline and audited - through the same or another connection`() =
        testApplication {
            val f = fixture("jbrelease")
            val admin = f.w.admin.client
            val other = admin.jbConnection(jbRequest(f.site))
            val dead = f.milestone()
            val old = admin.bindMilestone(f.connectionId, dead, "E2E-5")
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/milestones/$dead").status)
            withAuditCapture { audit ->
                val bound = f.w.projectOwner.client.bindMilestone(f.connectionId, f.milestone(), "E2E-5")
                assertFalse(jbActive(old.id), "the dead node's binding is released")
                assertTrue(jbActive(bound.id))
                val released = assertNotNull(
                    audit.awaitEvent { it.message == "jira.binding_released" && it.hasKeyValue("bindingId", old.id.toLong()) },
                )
                assertTrue(released.hasKeyValue("reason", "NODE_GONE") && released.hasKeyValue("issueKey", "E2E-5"))
                assertTrue(released.hasKeyValue("connectionId", f.connectionId.toLong()) && released.hasKeyValue("level", "MILESTONE"))
                assertTrue(released.hasKeyValue("byUserId", f.w.projectOwner.userId.toLong()))
                assertTrue(released.hasKeyValue("nodeId", dead.toLong()))
                val created = assertNotNull(
                    audit.awaitEvent { it.message == "jira.binding_created" && it.hasKeyValue("bindingId", bound.id.toLong()) },
                )
                assertTrue(created.hasKeyValue("byUserId", f.w.projectOwner.userId.toLong()))
                assertTrue(created.hasKeyValue("connectionId", f.connectionId.toLong()))
                assertTrue(created.hasKeyValue("level", "MILESTONE") && created.hasKeyValue("nodeKind", "MILESTONE"))
                assertTrue(created.hasKeyValue("nodeId", bound.node.id.toLong()))
                assertTrue(created.hasKeyValue("issueId", "90005") && created.hasKeyValue("issueKey", "E2E-5"))
                val order = audit.events.map { it.message }.filter { it.startsWith("jira.binding_") }
                assertTrue(order.indexOf("jira.binding_released") < order.indexOf("jira.binding_created"), "the release is reported first")
            }
            // Through ANOTHER connection of the site (D1), and by the death of an ANCESTOR (the whole project goes).
            val parent = TestPlan.project(f.w.programId, f.w.projectOwner.personId!!)
            val child = TestPlan.milestone(parent, f.w.requireTeams().teamId)
            val viaOther = admin.bindMilestone(other.id, child, "E2E-7")
            assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/projects/$parent").status)
            admin.bindMilestone(f.connectionId, f.milestone(), "E2E-7")
            assertFalse(jbActive(viaOther.id))
            // A LIVE holder is never released.
            assertEquals(HttpStatusCode.Conflict, admin.jbBind(f.connectionId, JiraLevel.MILESTONE, f.milestone(), "E2E-7").status)
        }

    @Test
    fun `D1 - a DISABLED connection of the site still holds its issue`() = testApplication {
        val f = fixture("jbd1off")
        val admin = f.w.admin.client
        val other = admin.jbConnection(jbRequest(f.site))
        admin.bindMilestone(f.connectionId, f.milestone(), "E2E-5")
        val disabled = jbRequest(f.site).copy(name = "jb-off-${System.nanoTime()}", apiToken = null, enabled = false)
        val storedText = admin.get("$JB_CONNECTIONS/${f.connectionId}").bodyAsText()
        val stored = jbJson.decodeFromString<ch.nokillswit.jira.JiraConnectionResponse>(storedText)
        assertEquals(HttpStatusCode.NoContent, admin.putJson("$JB_CONNECTIONS/${f.connectionId}", disabled.copy(name = stored.name)).status)
        val refused = admin.jbBind(other.id, JiraLevel.MILESTONE, f.milestone(), "E2E-5")
        assertEquals(HttpStatusCode.Conflict, refused.status, "disabling a connection unbinds nothing")
        assertEquals("urn:astrolabe:problem:already-bound", refused.jbProblem().type)
        assertEquals(1, jbActiveOnSite(f.site, "90005"))
    }

    @Test
    fun `a release followed by a refusal rolls back - the dead binding stays active and no event fires`() = testApplication {
        val f = fixture("jbrollback")
        val admin = f.w.admin.client
        val other = admin.jbConnection(jbRequest(f.site))
        val dead = f.milestone()
        val old = admin.bindMilestone(f.connectionId, dead, "E2E-5")
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/milestones/$dead").status)
        // A state no bind can create: a LIVE holder of the same issue on another connection of the site, with the higher id, so the
        // bind releases the dead one first and only then meets the live one and refuses.
        val live = f.milestone()
        jbSql(
            "INSERT INTO jira_bindings (connection_id, level, milestone_id, jira_issue_id, jira_issue_key, created_at, updated_at) " +
                "VALUES (?, 'MILESTONE', ?, '90005', 'E2E-5', 1, 1)",
            other.id.toInt(), live.toInt(),
        )
        withAuditCapture { audit ->
            val refused = f.w.projectOwner.client.jbBind(f.connectionId, JiraLevel.MILESTONE, f.milestone(), "E2E-5")
            assertEquals(HttpStatusCode.Conflict, refused.status)
            assertTrue(jbActive(old.id), "the release was rolled back with the refused bind")
            // A positive control that cannot false-pass: events arrive in order, so once the unbind below is audited anything the refused
            // bind had emitted is already in the list.
            assertEquals(HttpStatusCode.NoContent, admin.delete("$JB_BINDINGS/${old.id}").status)
            assertNotNull(audit.awaitEvent { it.message == "jira.binding_deleted" && it.hasKeyValue("bindingId", old.id.toLong()) })
            assertTrue(audit.events.none { it.message == "jira.binding_released" || it.message == "jira.binding_created" })
        }
    }

    @Test
    fun `D2 - deleting a connection unbinds its bindings in the same transaction, so nodes and issues are free again`() = testApplication {
        val f = fixture("jbd2")
        val admin = f.w.admin.client
        val other = admin.jbConnection(jbRequest(f.site))
        val node = f.milestone()
        val binding = admin.bindMilestone(f.connectionId, node, "E2E-5")
        val keep = admin.bindMilestone(other.id, f.milestone(), "E2E-7")
        withAuditCapture { audit ->
            assertEquals(HttpStatusCode.NoContent, admin.delete("$JB_CONNECTIONS/${f.connectionId}").status)
            val event = assertNotNull(
                audit.awaitEvent { it.message == "jira.connection_deleted" && it.hasKeyValue("connectionId", f.connectionId.toLong()) },
            )
            assertTrue(event.hasKeyValue("bindingsUnbound", 1))
        }
        assertFalse(jbActive(binding.id))
        assertTrue(jbActive(keep.id), "another connection's binding is untouched")
        assertEquals(HttpStatusCode.NotFound, admin.get("$JB_BINDINGS/${binding.id}").status)
        // Neither the node nor the issue stays blocked.
        admin.bindMilestone(other.id, node, "E2E-5")
    }

    // --- the reads ----------------------------------------------------------------------------------------------------------------------

    private suspend fun HttpClient.page(query: String): JsonObject {
        val response = get("$JB_BINDINGS?$query")
        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        return Json.parseToJsonElement(response.bodyAsText()).jsonObject
    }

    private fun JsonObject.keys() = getValue("items").jsonArray.map { it.jsonObject.getValue("issueKey").jsonPrimitive.content }

    @Test
    fun `the list is paged, sortable and filterable by connection, level and node name - for any authenticated user`() = testApplication {
        val f = fixture("jblist")
        val w = f.w
        val admin = w.admin.client
        val other = admin.jbConnection(jbRequest(jbSite()))
        val alpha = f.milestone("Ünïcode Épic ${planName("alpha")}")
        val beta = f.milestone("Plain ${planName("beta")}")
        admin.bindMilestone(f.connectionId, alpha, "E2E-5")
        admin.bindMilestone(f.connectionId, beta, "E2E-7")
        admin.jbBind(f.connectionId, JiraLevel.PROJECT, w.projectId, "E2E-2").jbBinding()
        admin.bindMilestone(other.id, f.milestone(), "E2E-5")
        val reader = w.stranger.client
        val all = reader.page("connectionId=${f.connectionId}&sort=issueKey")
        assertEquals(listOf("E2E-2", "E2E-5", "E2E-7"), all.keys())
        assertEquals(3, all.getValue("total").jsonPrimitive.content.toInt())
        assertEquals(listOf("E2E-7", "E2E-5"), reader.page("connectionId=${f.connectionId}&level=MILESTONE&sort=-issueKey").keys())
        assertEquals(listOf("E2E-2"), reader.page("connectionId=${f.connectionId}&level=PROJECT").keys())
        // q: the NODE's name, case- and accent-insensitive.
        assertEquals(listOf("E2E-5"), reader.page("connectionId=${f.connectionId}&q=UNICODE%20epic").keys())
        assertEquals(listOf("E2E-7"), reader.page("connectionId=${f.connectionId}&q=plain").keys())
        assertEquals(emptyList(), reader.page("connectionId=${f.connectionId}&q=nothing-like-this").keys())
        // Paging: total is before pagination.
        val second = reader.page("connectionId=${f.connectionId}&sort=id&pageSize=2&page=2")
        assertEquals(1, second.keys().size)
        assertEquals(3, second.getValue("total").jsonPrimitive.content.toInt())
        // The shape of one row.
        val row = reader.page("connectionId=${f.connectionId}&level=MILESTONE&sort=id").getValue("items").jsonArray.first().jsonObject
        assertEquals("MILESTONE", row.getValue("level").jsonPrimitive.content)
        assertEquals(alpha.toString(), row.getValue("node").jsonObject.getValue("id").jsonPrimitive.content)
        assertTrue(row.getValue("url").jsonPrimitive.content.endsWith("/browse/E2E-5"))
        assertNotNull(row["observation"])
        // Validation: unknown sort, repeated and malformed filters.
        val malformed = listOf(
            "sort=nope", "connectionId=1&connectionId=2", "connectionId=x", "level=TEAM", "level=PROJECT&level=PROGRAM", "pageSize=101",
            "q=" + "q".repeat(101),
        )
        for (bad in malformed) {
            assertEquals(HttpStatusCode.BadRequest, reader.get("$JB_BINDINGS?$bad").status, bad)
        }
        // A binding whose node is gone is not listed.
        assertEquals(HttpStatusCode.NoContent, admin.delete("/api/v1/milestones/$beta").status)
        assertEquals(listOf("E2E-2", "E2E-5"), reader.page("connectionId=${f.connectionId}&sort=issueKey").keys())
    }

    @Test
    fun `GET returns the binding for any authenticated user and is 404 for an unknown id`() = testApplication {
        val f = fixture("jbget")
        val binding = f.w.admin.client.bindMilestone(f.connectionId, f.milestone(), "E2E-5")
        val read = f.w.personless.client.get("$JB_BINDINGS/${binding.id}")
        assertEquals(HttpStatusCode.OK, read.status)
        val decoded = jbJson.decodeFromString<JiraBindingResponse>(read.bodyAsText())
        assertEquals(binding, decoded)
        assertEquals(HttpStatusCode.NotFound, f.w.admin.client.get("$JB_BINDINGS/999999").status)
        assertEquals(HttpStatusCode.NotFound, f.w.admin.client.get("$JB_BINDINGS/0").status)
    }

    @Test
    fun `no audit line of a bind carries the token`() = testApplication {
        val f = fixture("jbaudit")
        val token = f.token
        val basic = java.util.Base64.getEncoder().encodeToString("jira.user@example.test:$token".toByteArray())
        val root = LogCapture("ROOT")
        try {
            withAuditCapture { audit ->
                val binding = f.w.admin.client.bindMilestone(f.connectionId, f.milestone(), "E2E-5")
                f.w.admin.client.delete("$JB_BINDINGS/${binding.id}")
                assertNotNull(audit.awaitEvent { it.message == "jira.binding_deleted" && it.hasKeyValue("bindingId", binding.id.toLong()) })
                for (capture in listOf(audit, root)) {
                    assertTrue(capture.events.isNotEmpty())
                    assertTrue(
                        capture.events.none { event ->
                            listOf(token, basic).any { secret ->
                                secret in event.formattedMessage || event.keyValuePairs.orEmpty().any { secret in it.value.toString() }
                            }
                        },
                        "no audit or application log line carries the token or its Basic header",
                    )
                }
            }
        } finally {
            root.detach()
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
