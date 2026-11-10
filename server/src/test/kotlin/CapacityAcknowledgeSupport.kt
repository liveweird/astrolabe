package ch.nokillswit

import ch.nokillswit.flow.CapacityAcknowledgeAllRequest
import ch.nokillswit.flow.CapacityAcknowledgeBatch
import ch.nokillswit.flow.CapacityAcknowledgeRequest
import ch.nokillswit.flow.CapacityAcknowledgement
import ch.nokillswit.flow.CapacityDeviation
import ch.nokillswit.flow.CapacityDeviationView
import ch.nokillswit.sync.SyncTrigger
import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.ApplicationTestBuilder
import kotlin.test.assertEquals

// Shared by the capacity acknowledge test classes (CapacityAcknowledgeTest, CapacityAcknowledgeRaceTest). A SCRIPTED Flow (a MockFlow
// document, FlowRunSupport) with two 2049 teams: nothing here touches the shared Flow stub (StubWarmupGuardTest).

const val CAPACK_PREFIX = "capack"

fun capAckUrl(bindingId: UInt) = "$FB_BINDINGS/$bindingId/acknowledge"

suspend fun HttpClient.capAck(bindingId: UInt, sprintId: Long?, fingerprint: String): HttpResponse =
    postJson(capAckUrl(bindingId), CapacityAcknowledgeRequest(sprintId, fingerprint))

/** `POST …/acknowledge` with a raw body (a malformed one). */
suspend fun HttpClient.capAckRaw(bindingId: UInt, body: String): HttpResponse = post(capAckUrl(bindingId)) {
    contentType(ContentType.Application.Json)
    setBody(body)
}

fun capAckAllUrl(bindingId: UInt) = "${capAckUrl(bindingId)}-all"

/** `POST …/acknowledge-all` naming [items] (sprint id - null = the team's own row - and the fingerprint read), in this order. */
suspend fun HttpClient.capAckAll(bindingId: UInt, vararg items: Pair<Long?, String>): HttpResponse =
    postJson(capAckAllUrl(bindingId), CapacityAcknowledgeAllRequest(items.map { CapacityAcknowledgeRequest(it.first, it.second) }))

/** `POST …/acknowledge-all` with a raw body (a malformed one). */
suspend fun HttpClient.capAckAllRaw(bindingId: UInt, body: String): HttpResponse = post(capAckAllUrl(bindingId)) {
    contentType(ContentType.Application.Json)
    setBody(body)
}

suspend fun HttpResponse.capBatch(): CapacityAcknowledgeBatch {
    assertEquals(HttpStatusCode.OK, status, bodyAsText())
    return fbJson.decodeFromString(bodyAsText())
}

/** `DELETE …/acknowledge` with the raw [query] (`""`, `"?sprintId=2"`, …). */
suspend fun HttpClient.capUnack(bindingId: UInt, query: String = ""): HttpResponse = delete("${capAckUrl(bindingId)}$query")

suspend fun HttpResponse.capAcknowledgement(): CapacityAcknowledgement {
    assertEquals(HttpStatusCode.OK, status, bodyAsText())
    return fbJson.decodeFromString(bodyAsText())
}

/** The number of acknowledgement rows stored for the binding (the stored-state assertion). */
fun capAckStored(bindingId: UInt): Int =
    jbScalar("SELECT count(*) FROM flow_capacity_acknowledgements WHERE binding_id = ?", bindingId.toInt()) { it.getInt(1) }

/** A stored row as `sprintId|fingerprint|byUserId|at`; `-` stands for a NULL sprint (the TEAM_GONE row). */
fun capAckRow(bindingId: UInt, sprintId: Long?): String? = PostgresTestSupport.connect().use { c ->
    c.prepareStatement(
        "SELECT coalesce(sprint_id::text, '-') || '|' || fingerprint || '|' || ack_by_user_id || '|' || ack_at FROM " +
            "flow_capacity_acknowledgements WHERE binding_id = ? AND sprint_id IS NOT DISTINCT FROM ?",
    ).use { st ->
        st.setInt(1, bindingId.toInt())
        st.setObject(2, sprintId)
        st.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
    }
}

private fun capAckSprints(dayTwo: Boolean, s2Name: String) = listOf(
    ciSprint(1, "S1", "2049-03-01", "2049-03-12", "40"),
    ciSprint(2, s2Name, "2049-03-15", "2049-03-26", if (dayTwo) "30" else "36"),
    ciSprint(3, "S3", "2049-03-29", "2049-04-09", if (dayTwo) "48" else "44"),
)

private suspend fun ScriptedFlowMirror.capAckRefresh(flowName: String, dayTwo: Boolean, s2Name: String) {
    val team = flowTeamDoc(1, flowName, sprints = capAckSprints(dayTwo, s2Name))
    if (dayTwo) refresh(team) else refresh(team, flowTeamDoc(2, "Billing"))
}

/**
 * The standard world: a Flow team "E2E-like" of three consecutive 2049 sprints (S1, S2, S3: 20, 18 and 22 man-days a week on day one),
 * linked to the plan world's team and IMPORTED by its manager, and a second Flow team "Billing" linked to the other team. [dayTwo] flips
 * Flow to its figures of the next day: S2 30 (the plan keeps 36: a WARNING, +6.00), S3 48 (the plan keeps 44: an INFO, -4.00), S1 in
 * line, and Billing gone from the document.
 */
class CapAckWorld(
    val w: PlanWorld,
    val mirror: ScriptedFlowMirror,
    private val flowName: String,
    val bindingId: UInt,
    val billingBindingId: UInt,
) {
    val teamId: UInt get() = w.requireTeams().teamId
    val manager: PlanCaller get() = w.requireTeams().manager

    /** Re-reads the scripted Flow: day two when [dayTwo] (Billing vanishes), with sprint 2 under [s2Name]. */
    suspend fun refresh(dayTwo: Boolean = true, s2Name: String = "S2") = mirror.capAckRefresh(flowName, dayTwo, s2Name)

    /**
     * Re-reads the scripted Flow (day-two figures) with ONLY the E2E team's sprints [sprintIds] (none = the team is listed with ZERO
     * sprints) and no Billing; [truncated] says `sprintsTruncated`, so a sprint missing from it was merely not sent.
     */
    suspend fun refreshOnly(
        vararg sprintIds: Long,
        truncated: Boolean = false,
        trigger: SyncTrigger = SyncTrigger.MANUAL,
        byUserId: UInt? = null,
    ) {
        val sprints = capAckSprints(dayTwo = true, "S2").filterIndexed { i, _ -> (i + 1).toLong() in sprintIds }
        val team = flowTeamDoc(1, flowName, sprints = sprints)
        if (truncated) mirror.refreshSprintsTruncated(team) else mirror.refresh(team, trigger = trigger, byUserId = byUserId)
    }

    /** The rows of the view for binding [id], as [this] caller reads them (default: the E2E team's binding). */
    suspend fun HttpClient.rowsOf(id: UInt = bindingId): List<CapacityDeviation> {
        val response = get("/api/v1/views/capacity-deviations?connectionId=${mirror.connectionId}&teamId=${teamOf(id)}")
        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        return fbJson.decodeFromString<CapacityDeviationView>(response.bodyAsText()).items.singleOrNull { it.bindingId == id }
            ?.deviations.orEmpty()
    }

    private fun teamOf(id: UInt): UInt =
        jbScalar("SELECT team_id FROM flow_team_bindings WHERE id = ?", id.toInt()) { it.getInt(1) }.toUInt()

    /** The row of sprint [sprintId] (null = the team's own `TEAM_GONE` row) of binding [id] as [this] caller reads it. */
    suspend fun HttpClient.rowOf(sprintId: Long?, id: UInt = bindingId): CapacityDeviation =
        rowsOf(id).single { it.detail.sprintId == sprintId }
}

/** Builds [CapAckWorld] on day one with the manager's import done, then registers its mirror in [mirrors] for the class's cleanup. */
suspend fun ApplicationTestBuilder.capAckWorld(label: String, mirrors: MutableList<ScriptedFlowMirror>): CapAckWorld {
    usePostgresTestcontainer()
    val w = planWorld(label, teams = true)
    val t = w.requireTeams()
    val flowName = planName("$CAPACK_PREFIX-flow")
    val mirror = ScriptedFlowMirror(CAPACK_PREFIX).connect().also { mirrors += it }
    mirror.capAckRefresh(flowName, dayTwo = false, s2Name = "S2")
    val binding = w.admin.client.fbBind(mirror.connectionId, 1, t.teamId).fbBinding()
    val billing = w.admin.client.fbBind(mirror.connectionId, 2, t.otherTeamId).fbBinding()
    val preview = t.manager.client.ciPreviewOf(binding.id)
    val applied = t.manager.client.ciApply(binding.id, ciBodyOf(preview))
    assertEquals(HttpStatusCode.OK, applied.status, applied.bodyAsText())
    return CapAckWorld(w, mirror, flowName, binding.id, billing.id)
}
