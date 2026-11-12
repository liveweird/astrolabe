package ch.nokillswit

import ch.nokillswit.jira.JiraImportDefaults
import ch.nokillswit.jira.JiraImportScope
import ch.nokillswit.jira.JiraLevel
import com.github.tomakehurst.wiremock.client.WireMock.anyRequestedFor
import com.github.tomakehurst.wiremock.client.WireMock.anyUrl
import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.statement.HttpResponse
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The import routes decrypt the stored token only AFTER the up-front checks: a login that owns no plan node, or names a default it
 * does not own, is refused first (`security.md` "A caller refused by the up-front checks never makes the server decrypt"). The seam is
 * the decrypt-failure log of `JiraConnectionService.targetOf`: the connection's envelope is made undecryptable, so every decrypt of it
 * leaves one WARN line naming the connection id (the class only, never the envelope) - a refused caller must leave none, an admitted
 * one exactly one (the positive control that proves the seam fires).
 */
class JiraImportDecryptOrderTest {
    /**
     * The preview or the apply for [scope]; the apply ticks one well-formed row (the guards answer before the items are looked at, the
     * token check after their shape).
     */
    private suspend fun HttpClient.importCall(route: String, id: UInt, scope: JiraImportScope): HttpResponse =
        if (route == "preview") preview(id, scope) else applyImport(id, scope, listOf(createTick("95001", JiraLevel.PROGRAM)))

    @Test
    fun `a refused caller never makes the server decrypt the stored token, on either import route`() = testApplication {
        val f = importFixture("jidec")
        val admin = f.w.admin.client
        val unreadable = admin.jbConnection(jbRequest(keys = listOf("IMP")))
        jbSql("UPDATE jira_connections SET api_token = 'enc:v1:not-a-real-envelope' WHERE id = ?", unreadable.id.toInt())
        val root = LogCapture("ROOT")
        try {
            fun decrypts() = root.events.count { "connection ${unreadable.id} cannot be decrypted" in it.formattedMessage }
            val namedProgram = JiraImportDefaults(programId = f.w.programId, teamId = f.defaultTeam)
            for (route in listOf("preview", "apply")) {
                // 403 for a login that owns no plan node (the person-less and the editor included) ...
                for ((name, caller) in f.w.outsiders) {
                    val refused = caller.client.importCall(route, unreadable.id, f.scope())
                    assertEquals(HttpStatusCode.Forbidden, refused.status, "$route $name")
                }
                // ... and for an owner who names a default they do not own.
                val named = f.w.projectOwner.client.importCall(route, unreadable.id, f.scope(namedProgram))
                assertEquals(HttpStatusCode.Forbidden, named.status, "$route named default")
            }
            assertEquals(0, decrypts(), "no refused request decrypted the token")

            // The positive control: an ADMITTED owner reaches the decrypt (and answers the typed 409), on each route.
            for (route in listOf("preview", "apply")) {
                val admitted = f.w.streamOwner.client.importCall(route, unreadable.id, f.scope())
                assertEquals(HttpStatusCode.Conflict, admitted.status, route)
                assertEquals("urn:astrolabe:problem:jira-token-unreadable", admitted.jbProblem().type, route)
            }
            assertEquals(2, decrypts(), "an admitted caller decrypts once per request")
        } finally {
            root.detach()
            // The deleted row holds NULL: no undecryptable envelope is left in the shared table for a later rotation test.
            admin.delete("$JB_CONNECTIONS/${unreadable.id}")
        }
    }

    @Test
    fun `a caller refused by the root's guard decrypts nothing and calls Jira never, on either route`() = testApplication {
        val f = importFixture("jidecr", keys = listOf("IMC"))
        val admin = f.w.admin.client
        val root = f.linkProgram()
        val unreadable = admin.jbConnection(jbRequest(keys = listOf("IMC")))
        jbSql("UPDATE jira_connections SET api_token = 'enc:v1:not-a-real-envelope' WHERE id = ?", unreadable.id.toInt())
        val log = LogCapture("ROOT")
        try {
            fun decrypts() = log.events.count { "connection ${unreadable.id} cannot be decrypted" in it.formattedMessage }
            val refused = listOf("projectOwner" to f.w.projectOwner) + f.w.outsiders
            JiraStubServer.resetRequests()
            for (route in listOf("preview", "apply")) {
                for ((name, caller) in refused) {
                    // Neither the connection whose token cannot be read nor the readable one is touched by a refused caller.
                    for (id in listOf(unreadable.id, f.connectionId)) {
                        val answer = caller.client.importCall(route, id, f.scope(root = root))
                        assertEquals(HttpStatusCode.Forbidden, answer.status, "$route $name $id")
                    }
                }
            }
            assertEquals(0, decrypts(), "no refused request decrypted the token")
            assertEquals(0, JiraStubServer.countRequests(anyRequestedFor(anyUrl())), "no refused request called Jira")

            // The positive controls: the root's owner reaches the decrypt on the unreadable connection, and Jira on the readable one.
            for (route in listOf("preview", "apply")) {
                val admitted = f.w.programOwner.client.importCall(route, unreadable.id, f.scope(root = root))
                assertEquals(HttpStatusCode.Conflict, admitted.status, route)
                assertEquals("urn:astrolabe:problem:jira-token-unreadable", admitted.jbProblem().type, route)
            }
            assertEquals(2, decrypts(), "an admitted caller decrypts once per request")
            assertEquals(HttpStatusCode.OK, f.w.programOwner.client.preview(f.connectionId, f.scope(root = root)).status)
            assertTrue(JiraStubServer.countRequests(anyRequestedFor(anyUrl())) > 0, "an admitted caller's rooted read reaches Jira")
        } finally {
            log.detach()
            admin.delete("$JB_CONNECTIONS/${unreadable.id}")
        }
    }

    @Test
    fun `an unknown or deleted connection is a 404 on both routes, for a login that owns nothing too`() = testApplication {
        val f = importFixture("jidec404")
        val gone = f.w.admin.client.jbConnection(jbRequest(keys = listOf("IMP")))
        assertEquals(HttpStatusCode.NoContent, f.w.admin.client.delete("$JB_CONNECTIONS/${gone.id}").status)
        for (route in listOf("preview", "apply")) {
            for (id in listOf(999_999u, gone.id)) {
                for ((name, caller) in f.w.outsiders + listOf("owner" to f.w.streamOwner, "admin" to f.w.admin)) {
                    assertEquals(HttpStatusCode.NotFound, caller.client.importCall(route, id, f.scope()).status, "$route $id $name")
                }
            }
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
