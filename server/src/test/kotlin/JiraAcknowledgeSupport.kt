package ch.nokillswit

import ch.nokillswit.jira.AcknowledgeRequest
import ch.nokillswit.jira.Acknowledgement
import ch.nokillswit.jira.DeviationItem
import ch.nokillswit.jira.JiraLevel
import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals

// Shared by the acknowledge test classes. Seeded worlds only (`DeviationSupport`): connections through the API, discovery and mapping
// written straight into the columns, bindings and observations as raw INSERTs - nothing here touches the Jira stub.

fun ackUrl(bindingId: UInt) = "$JB_BINDINGS/$bindingId/acknowledge"

suspend fun HttpClient.ack(bindingId: UInt, fingerprint: String): HttpResponse =
    postJson(ackUrl(bindingId), AcknowledgeRequest(fingerprint))

/** `POST …/acknowledge` with a raw body (a malformed one). */
suspend fun HttpClient.ackRaw(bindingId: UInt, body: String): HttpResponse = post(ackUrl(bindingId)) {
    contentType(ContentType.Application.Json)
    setBody(body)
}

suspend fun HttpClient.unack(bindingId: UInt): HttpResponse = delete(ackUrl(bindingId))

suspend fun HttpResponse.acknowledgement(): Acknowledgement {
    assertEquals(HttpStatusCode.OK, status, bodyAsText())
    return jbJson.decodeFromString(bodyAsText())
}

/** One binding's item as [this] sees it (`all=true` on its own connection, so the item is listed whatever its state). */
suspend fun HttpClient.ackItem(connectionId: UInt, bindingId: UInt): DeviationItem =
    dvView("connectionId=$connectionId&all=true").byBinding().getValue(bindingId)

/**
 * The throwaway connections one test made. The suite shares one database and other tests read the connection registry 100 to a page,
 * so a test removes its own rows: [drop] does in SQL what `DELETE /connections/{id}` does, in the class's `@After`.
 */
class ConnectionLedger {
    private val ids = mutableListOf<UInt>()

    fun track(id: UInt): UInt = id.also { ids += it }

    /**
     * The connection delete's effect (D2: no active binding on a deleted connection): bindings unbound, runs and census mirror gone, then
     * the connection.
     */
    fun drop() {
        ids.forEach { id ->
            jbSql("UPDATE jira_bindings SET marked_as_deleted = TRUE WHERE connection_id = ?", id.toInt())
            jbSql("DELETE FROM sync_runs WHERE connection_id = ?", id.toInt())
            jbSql("DELETE FROM jira_issues WHERE connection_id = ?", id.toInt())
            jbSql("UPDATE jira_connections SET marked_as_deleted = TRUE WHERE id = ?", id.toInt())
        }
        ids.clear()
    }
}

private val issueCounter = AtomicInteger(50_000)

/** A fresh Jira issue id: bindings are unique per connection and per site, and every seeded connection has its own site. */
fun nextIssue(): Pair<String, String> = issueCounter.incrementAndGet().let { "$it" to "ACK-$it" }

/**
 * An ACTIVE binding of [level] node [nodeId] on [connectionId] that DEVIATES: the observation's summary is not the node's name
 * (`RENAMED`, INFO) and, for a milestone scheduled [planEnd] against Jira's end, the plan's end is later (`END_DIFFERS`, WARNING).
 */
fun deviatingBinding(
    connectionId: UInt,
    level: JiraLevel,
    nodeId: UInt,
    summary: String = "Somebody else's name",
    start: String? = null,
    end: String? = null,
): UInt {
    val (issueId, key) = nextIssue()
    val hierarchy = when (level) {
        JiraLevel.PROGRAM -> 3
        JiraLevel.PROJECT -> 2
        JiraLevel.MILESTONE -> 1
    }
    return dvBind(connectionId, level, nodeId, issueId, key, DvObs(summary, hierarchy, start = start, end = end))
}
