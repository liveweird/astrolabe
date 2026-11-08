package ch.nokillswit

import ch.nokillswit.flow.FlowTeamBindRequest
import ch.nokillswit.flow.FlowTeamBindingResponse
import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.sync.SyncOutcome
import io.ktor.client.HttpClient
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlin.test.assertEquals

// Shared by the Flow team binding test classes (FlowTeamBindingTest, FlowTeamPanelTest, FlowTeamMatchTest). The mirror is filled by a REAL
// FlowObserver run over a scripted MockFlow document (the harness of FlowRunSupport.kt), so the routes under test read exactly the rows a
// run writes. Nothing here touches the shared Flow stub.

const val FB_BINDINGS = "/api/v1/integrations/flow/team-bindings"
const val FB_TEAMS = "/api/v1/integrations/flow/teams"
const val FB_CONNECTIONS = "/api/v1/integrations/flow/connections"

val fbJson = Json { ignoreUnknownKeys = true }

/** A connection (created by [harness]) whose mirror is whatever [refresh] last put there; the scripted Flow answers [document]. */
class ScriptedFlowMirror(private val prefix: String) {
    private var document = flowDocument()
    private val mock = MockFlow { flowOk(document) }
    val harness = mock.harness()
    var connectionId: UInt = 0u
        private set

    suspend fun connect(timeZone: String = "Europe/Warsaw"): ScriptedFlowMirror {
        connectionId = harness.connect(prefix, FLOW_TEST_ORIGIN, timeZone = timeZone)
        return this
    }

    /** Runs the connection against a document of exactly [teams] (JSON rows of `flowTeamDoc`/`flowTeamJson`). */
    suspend fun refresh(vararg teams: String): ScriptedFlowMirror {
        document = flowDocument(*teams)
        check(harness.run(connectionId).outcome == SyncOutcome.SUCCEEDED) { "the scripted run must succeed" }
        return this
    }

    /** Like [refresh], but the document says `teamsTruncated`: the mirror keeps the teams it already had that [teams] omit. */
    suspend fun refreshTruncated(vararg teams: String): ScriptedFlowMirror {
        document = flowDocument(*teams, teamsTruncated = true)
        check(harness.run(connectionId).outcome == SyncOutcome.SUCCEEDED) { "the scripted run must succeed" }
        return this
    }

    fun cleanUp() = harness.cleanUp(prefix)
}

private fun quoted(text: String) = JsonPrimitive(text).toString()

/** One team of a document with explicit [members] and [sprints] (raw JSON rows, see [flowMemberJson], [flowSprintJson]). */
fun flowTeamDoc(id: Int, name: String, members: List<String> = emptyList(), sprints: List<String> = emptyList()): String =
    """{"id":$id,"name":${quoted(name)},"managerName":null,"defaultCapacityMd":30,"members":[${members.joinToString(",")}],""" +
        """"sprints":[${sprints.joinToString(",")}]}"""

fun flowMemberJson(account: String, name: String?, from: Long, to: Long?): String =
    """{"accountId":${quoted(account)},"displayName":${name?.let(::quoted) ?: "null"},"validFrom":$from,"validTo":${to ?: "null"}}"""

fun flowSprintJson(id: Long, startAt: Long?, endAt: Long?): String =
    """{"sprintId":$id,"connectionId":3,"name":"Sprint $id","state":"future","startAt":${startAt ?: "null"},"endAt":${endAt ?: "null"},""" +
        """"completeAt":null,"hasCalendar":true,"capacityMd":40,"capacitySource":"CALENDAR"}"""

suspend fun HttpClient.fbBind(connectionId: UInt, flowTeamId: Int, teamId: UInt): HttpResponse =
    postJson(FB_BINDINGS, FlowTeamBindRequest(connectionId, flowTeamId, teamId))

suspend fun HttpResponse.fbBinding(): FlowTeamBindingResponse {
    assertEquals(HttpStatusCode.Created, status, "expected a created binding, got ${bodyAsText()}")
    return fbJson.decodeFromString(bodyAsText())
}

suspend fun HttpResponse.fbProblem(): ProblemDetail = fbJson.decodeFromString(bodyAsText())

/** Whether binding [id] is still ACTIVE in the table (a soft-deleted row stays as history). */
fun fbActive(id: UInt): Boolean =
    jbScalar("SELECT NOT marked_as_deleted FROM flow_team_bindings WHERE id = ?", id.toInt()) { it.getBoolean(1) }

/** The number of ACTIVE bindings of the connection. */
fun fbActiveCount(connectionId: UInt): Int =
    jbScalar(
        "SELECT count(*) FROM flow_team_bindings WHERE connection_id = ? AND NOT marked_as_deleted", connectionId.toInt(),
    ) { it.getInt(1) }

fun String.fbObject(): JsonObject = fbJson.parseToJsonElement(this).jsonObject

/** The member, or null when it is absent or a JSON null (a nullable field the server always sends). */
fun JsonObject.fbNullable(key: String) = this[key]?.takeUnless { it is JsonNull }

fun JsonObject.fbItems(): List<JsonObject> = getValue("items").jsonArray.map { it.jsonObject }
