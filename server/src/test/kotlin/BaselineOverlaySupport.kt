package ch.nokillswit

import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.planning.UNKNOWN_BASELINE_PROBLEM
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/*
 * What the four `?baseline=` view tests share (v0.9 C7): the raw-JSON invariants of an ADDITIVE overlay and the 400 matrix of the
 * parameter. The rule they pin: a view requested WITHOUT the parameter has no `baseline` key anywhere (its bytes are what they were
 * before baselines), and with it the document equals the plain one plus the `baseline` keys.
 */

private val json = Json

/** The raw JSON tree of a GET (the typed DTOs would hide an extra or missing key). */
suspend fun HttpClient.rawJson(path: String): JsonElement = json.parseToJsonElement(get(path).bodyAsText())

/** [this] without every object member named `baseline`, at any depth. */
fun JsonElement.withoutBaseline(): JsonElement = when (this) {
    is JsonObject -> JsonObject(filterKeys { it != "baseline" }.mapValues { (_, v) -> v.withoutBaseline() })
    is JsonArray -> JsonArray(map { it.withoutBaseline() })
    else -> this
}

fun JsonElement.hasBaselineKey(): Boolean = withoutBaseline() != this

/**
 * Pins the overlay as additive on [path] (no query): the plain document has no `baseline` key at all, and the document of
 * `?baseline=[id]` minus its `baseline` keys IS the plain document (nothing else changed; no write may run in between).
 */
suspend fun HttpClient.assertOverlayIsAdditive(path: String, id: UInt) {
    val plain = rawJson(path)
    assertFalse(plain.hasBaselineKey(), "without the parameter the document carries no baseline key: $path")
    val overlay = rawJson("$path?baseline=$id")
    assertEquals(plain, overlay.withoutBaseline(), "the overlay only adds baseline keys: $path")
    assertEquals(true, overlay.hasBaselineKey(), "the overlay answers a baseline block: $path")
}

/**
 * The `?baseline=` rejections of a view at [path]: a malformed or repeated value is a plain 400, an id that is unknown, or soft-deleted
 * (this takes and deletes a baseline), is the 400 with the `unknown-baseline` problem type.
 */
suspend fun HttpClient.assertBaselineParameterRejected(path: String) {
    for (malformed in listOf("abc", "-1", "1.5", "99999999999", "1&baseline=2")) {
        val response = get("$path?baseline=$malformed")
        assertEquals(HttpStatusCode.BadRequest, response.status, "?baseline=$malformed")
        assertEquals("about:blank", response.body<ProblemDetail>().type, "?baseline=$malformed is a plain 400")
    }
    val unknown = get("$path?baseline=999999")
    assertEquals(HttpStatusCode.BadRequest, unknown.status)
    val problem = unknown.body<ProblemDetail>()
    assertEquals(UNKNOWN_BASELINE_PROBLEM, problem.type)
    assertEquals("Unknown or deleted baseline id: 999999", problem.detail)
    val deleted = TestPlan.baseline()
    TestPlan.deleteBaseline(deleted)
    val gone = get("$path?baseline=$deleted")
    assertEquals(HttpStatusCode.BadRequest, gone.status, "a soft-deleted baseline")
    assertEquals(UNKNOWN_BASELINE_PROBLEM, gone.body<ProblemDetail>().type)
}
