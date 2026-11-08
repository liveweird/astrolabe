package ch.nokillswit

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The shared in-JVM WireMock over `sample-data/flow-stub` (the [StubServer] shape): the SAME mappings and `__files` the compose and
 * Kubernetes `flow-stub` image serves (`sample-data/flow/README.md`), Flow 1.57.0's service-token surface. Lazily started once per JVM
 * and SHARED across the whole suite. A test class that reads it warms it first (`FlowStubFixture.warm()`, `StubWarmupGuardTest`).
 * Its scenarios are `flow-day2` (state `day2`) and `flow-outage` (state `down`): a test that flips one MUST `resetScenarios()` in a
 * `finally`.
 */
object FlowStubServer : StubServer("sample-data/flow-stub") {
    /**
     * The generator's `expected.json` (`sample-data/flow/expected.json`): the one place the stub's token, paths, field names and figures
     * are written for the JVM side, so no Kotlin constant can drift from `contract.mjs`.
     */
    val expected: JsonObject by lazy {
        val file = listOf("sample-data/flow/expected.json", "../sample-data/flow/expected.json").map(::File).firstOrNull { it.isFile }
            ?: error("sample-data/flow/expected.json not found from ${File(".").absolutePath}")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private val contract: JsonObject get() = expected.getValue("contract").jsonObject

    /** The only service token the stub accepts (public and fake; `expected.json` `contract.token`). */
    val token: String get() = contract.getValue("token").jsonPrimitive.content

    /** The only accepted `Authorization` header value: `Bearer <token>`. */
    val authorization: String get() = contract.getValue("authorization").jsonPrimitive.content

    /** The `sprintsSince` query parameter's name, and the fixed window start the stub's document carries (both from the generator). */
    val sinceParameter: String get() = expected.getValue("contract").jsonObject.getValue("sprintsSinceParameter").jsonPrimitive.content
    val sinceDate: String get() = expected.getValue("document").jsonObject.getValue("sprintsSince").jsonPrimitive.content

    /** The query string `?<sprintsSince>=<value>`. */
    fun sinceQuery(value: String): String = "?$sinceParameter=$value"

    /** The query a normal `teams` call sends: the fixed window start. */
    val defaultSinceQuery: String get() = sinceQuery(sinceDate)

    /** The two operations' paths, from the contract. */
    val mePath: String get() = contract.getValue("paths").jsonObject.getValue("me").jsonPrimitive.content
    val teamsPath: String get() = contract.getValue("paths").jsonObject.getValue("teams").jsonPrimitive.content
}
