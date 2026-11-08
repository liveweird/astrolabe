package ch.nokillswit

import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.LocalDateTime
import java.time.ZoneId

// Shared by the capacity import's preview/apply test classes: sprints over a scripted Flow document, the preview -> apply body, and the
// stored-state snapshots. NOTHING here touches the shared Flow stub (StubWarmupGuardTest).

private val CI_WARSAW: ZoneId = ZoneId.of("Europe/Warsaw")

/** The epoch millis of [date] at [time] in Europe/Warsaw. */
fun ciAt(date: String, time: String = "09:00"): Long = LocalDateTime.parse("${date}T$time").atZone(CI_WARSAW).toInstant().toEpochMilli()

/** A future sprint of Flow team 1: Monday 09:00 [start] to Friday 17:00 [end] (Warsaw), [md] man-days (null = Flow has none). */
fun ciSprint(id: Long, name: String, start: String, end: String, md: String?): String {
    val source = md?.let { "\"CALENDAR\"" } ?: "null"
    return """{"sprintId":$id,"connectionId":3,"name":"$name","state":"future","startAt":${ciAt(start)},"endAt":${ciAt(end, "17:00")},""" +
        """"completeAt":null,"hasCalendar":true,"capacityMd":${md ?: "null"},"capacitySource":$source}"""
}

suspend fun HttpClient.ciPreview(bindingId: UInt, body: String = "{}"): HttpResponse =
    post("$FB_BINDINGS/$bindingId/capacity-preview") {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

suspend fun HttpClient.ciApply(bindingId: UInt, body: String): HttpResponse =
    post("$FB_BINDINGS/$bindingId/capacity-import") {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

fun JsonObject.ciText(key: String) = getValue(key).jsonPrimitive.content

fun JsonObject.ciRows(key: String) = getValue(key).jsonArray.map { it.jsonObject }

/** One apply item: the row the preview showed for [sprintId], as the person ticked it. */
fun ciItem(sprintId: Long, action: String, effectiveFrom: String, mdPerWeek: String) =
    """{"sprintId":$sprintId,"expected":{"action":"$action","effectiveFrom":"$effectiveFrom","mdPerWeek":$mdPerWeek}}"""

fun ciBody(from: String, items: List<String>, removals: List<UInt> = emptyList(), includeClosed: Boolean = false) =
    """{"from":"$from","includeClosed":$includeClosed,"items":[${items.joinToString(",")}],"removals":[${removals.joinToString(",")}]}"""

/**
 * The apply body of a preview, the way the SPA builds it: every TICKED item with its `expected`, [removals] as given (a client never
 * preselects one), and the `from` and `includeClosed` the preview echoed.
 */
fun ciBodyOf(preview: JsonObject, removals: List<UInt> = emptyList()): String {
    val items = preview.ciRows("items").filter { it.ciText("ticked") == "true" }
        .map { ciItem(it.ciText("sprintId").toLong(), it.ciText("action"), it.ciText("effectiveFrom"), it.ciText("mdPerWeek")) }
    return ciBody(preview.ciText("from"), items, removals, preview.ciText("includeClosed").toBoolean())
}

suspend fun HttpClient.ciPreviewOf(bindingId: UInt, body: String = "{}"): JsonObject = ciPreview(bindingId, body).bodyAsText().fbObject()

fun ciSeedFlowPeriod(teamId: UInt, from: String, md: String, sprintId: Long, name: String, wip: Int? = null): UInt {
    jbSql(
        "INSERT INTO team_capacity_periods (team_id, effective_from, md_per_week, wip_limit, source, flow_sprint_id, flow_sprint_name, " +
            "created_at, updated_at) VALUES (?, ?::date, ?::numeric, ${wip ?: "NULL"}, 'FLOW', ?, ?, 1, 1)",
        teamId.toInt(), from, md, sprintId, name,
    )
    return jbScalar(
        "SELECT id FROM team_capacity_periods WHERE team_id = ? AND effective_from = ?::date AND NOT marked_as_deleted",
        teamId.toInt(), from,
    ) { it.getInt(1) }.toUInt()
}

/** Every column the import may touch, as one string: `date|md|wip|source|sprintId|sprintName|deleted|updatedAt`. */
fun ciRow(periodId: UInt): String = jbScalar(
    "SELECT effective_from::text || '|' || md_per_week::text || '|' || coalesce(wip_limit::text, '-') || '|' || source || '|' || " +
        "coalesce(flow_sprint_id::text, '-') || '|' || coalesce(flow_sprint_name, '-') || '|' || marked_as_deleted::text || '|' || " +
        "updated_at::text FROM team_capacity_periods WHERE id = ?",
    periodId.toInt(),
) { it.getString(1) }

/** The same without the update stamp (the created and updated rows' stamps are the clock's). */
fun ciRowShape(periodId: UInt): String = ciRow(periodId).substringBeforeLast('|')

/** Every period of the team (deleted ones too), as `ciRow` strings by id: a before/after snapshot. */
fun ciTeamRows(teamId: UInt): List<String> =
    PostgresTestSupport.connect().use { c ->
        c.prepareStatement("SELECT id FROM team_capacity_periods WHERE team_id = ? ORDER BY id").use { st ->
            st.setInt(1, teamId.toInt())
            st.executeQuery().use { rs ->
                buildList { while (rs.next()) add(rs.getInt(1).toUInt()) }
            }
        }
    }.map { "$it=${ciRow(it)}" }
