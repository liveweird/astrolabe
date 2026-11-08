package ch.nokillswit

import ch.nokillswit.jira.JiraAuthScheme
import ch.nokillswit.jira.JiraBindRequest
import ch.nokillswit.jira.JiraBindingResponse
import ch.nokillswit.jira.JiraConnectionRequest
import ch.nokillswit.jira.JiraConnectionResponse
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.plugins.ProblemDetail
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import kotlinx.serialization.json.Json
import java.util.UUID
import kotlin.test.assertEquals

// Shared by the Jira binding test classes. NOTHING here touches the shared stub (StubWarmupGuardTest): each test class starts its
// own app with `jira.stubBaseUrl` and warms the fixture in its @BeforeClass.

const val JB_CONNECTIONS = "/api/v1/integrations/jira/connections"
const val JB_BINDINGS = "/api/v1/integrations/jira/bindings"

val jbJson = Json { ignoreUnknownKeys = true }

/**
 * A site no other test uses. Bindings are 1:1 per SITE across connections (D1) and the suite shares one database, so a test that binds
 * stub issues on a private site can never meet another test's bindings; the stub answers every tenant host alike.
 */
fun jbSite() = "https://jb${UUID.randomUUID().toString().replace("-", "").take(12)}.atlassian.net"

fun jbRequest(
    site: String = jbSite(),
    keys: List<String> = listOf("E2E"),
    enabled: Boolean = true,
    token: String? = "JTOK-${UUID.randomUUID()}",
) =
    JiraConnectionRequest(
        "jb-${UUID.randomUUID().toString().take(8)}", site, "jira.user@example.test", token, JiraAuthScheme.BASIC, keys, enabled,
    )

/** A connection whose Test connection stored the stub's discovery (no mapping saved: the defaults are the effective mapping). */
suspend fun HttpClient.jbConnection(request: JiraConnectionRequest = jbRequest()): JiraConnectionResponse {
    val created = postJson(JB_CONNECTIONS, request)
    assertEquals(HttpStatusCode.Created, created.status)
    val connection = jbJson.decodeFromString<JiraConnectionResponse>(created.bodyAsText())
    assertEquals(HttpStatusCode.OK, post("$JB_CONNECTIONS/${connection.id}/test").status)
    return connection
}

suspend fun HttpClient.jbBind(connectionId: UInt, level: JiraLevel, nodeId: UInt, issueKey: String): HttpResponse =
    postJson(JB_BINDINGS, JiraBindRequest(connectionId, level, nodeId, issueKey))

suspend fun HttpResponse.jbBinding(): JiraBindingResponse {
    assertEquals(HttpStatusCode.Created, status, "expected a created binding, got ${bodyAsText()}")
    return jbJson.decodeFromString(bodyAsText())
}

suspend fun HttpResponse.jbProblem(): ProblemDetail = jbJson.decodeFromString(bodyAsText())

/** One scalar over raw JDBC (the stored-state assertions). */
fun <T> jbScalar(sql: String, vararg params: Any, read: (java.sql.ResultSet) -> T): T = PostgresTestSupport.connect().use { c ->
    c.prepareStatement(sql).use { st ->
        params.forEachIndexed { i, p -> st.setObject(i + 1, p) }
        st.executeQuery().use { rs ->
            rs.next()
            read(rs)
        }
    }
}

fun jbSql(statement: String, vararg params: Any) = PostgresTestSupport.connect().use { c ->
    c.prepareStatement(statement).use { st ->
        params.forEachIndexed { i, p -> st.setObject(i + 1, p) }
        st.executeUpdate()
    }
}

/** Whether binding [id] is still ACTIVE in the table (a soft-deleted row stays). */
fun jbActive(id: UInt): Boolean = jbScalar("SELECT NOT marked_as_deleted FROM jira_bindings WHERE id = ?", id.toInt()) { it.getBoolean(1) }

/** The number of ACTIVE bindings of Jira issue [issueId] over every connection of [site]. */
fun jbActiveOnSite(site: String, issueId: String): Int = jbScalar(
    "SELECT count(*) FROM jira_bindings b JOIN jira_connections c ON c.id = b.connection_id " +
        "WHERE NOT b.marked_as_deleted AND c.site_url = ? AND b.jira_issue_id = ?",
    site, issueId,
) { it.getInt(1) }
