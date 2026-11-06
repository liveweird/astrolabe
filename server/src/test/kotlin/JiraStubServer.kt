package ch.nokillswit

import com.github.tomakehurst.wiremock.WireMockServer
import com.github.tomakehurst.wiremock.client.MappingBuilder
import com.github.tomakehurst.wiremock.client.WireMock
import com.github.tomakehurst.wiremock.core.WireMockConfiguration
import com.github.tomakehurst.wiremock.stubbing.StubMapping
import java.io.File

/**
 * The shared in-JVM WireMock over `sample-data/jira-stub`: the SAME mappings and `__files` the compose and Kubernetes `jira-stub` image
 * serves (`sample-data/jira/README.md`), so the server suite exercises the Jira client against the generator-fixed contract rather than a
 * second, hand-rolled fixture that could drift from it. Lazily started once per JVM and SHARED across the whole suite, like
 * [PostgresTestSupport]. A test class that reads it warms it first (`JiraStubFixture.warm()`, `JiraStubWarmupGuardTest`).
 */
object JiraStubServer {
    /** The generator's fixed `cloudId` (`sample-data/jira/catalog.mjs`, `expected.json`). */
    const val CLOUD_ID = "b3f1a2c4-5d6e-4f7a-8b9c-0d1e2f3a4b5c"

    private val stubRoot: File by lazy {
        listOf(File("sample-data/jira-stub"), File("../sample-data/jira-stub"))
            .firstOrNull { it.isDirectory }
            ?: error("sample-data/jira-stub not found from ${File(".").absolutePath}")
    }

    private val server: WireMockServer by lazy {
        WireMockServer(
            WireMockConfiguration.options()
                .usingFilesUnderDirectory(stubRoot.absolutePath)
                .dynamicPort()
                // No test reads the request journal, and WireMock keeps it unbounded by default - every served request WITH its response
                // body, for the whole suite's lifetime in this shared singleton (Flow's 512 MiB test JVM ran out of heap on it).
                .disableRequestJournal(),
        ).apply {
            start()
            Runtime.getRuntime().addShutdownHook(Thread { stop() })
        }
    }

    private val client: WireMock by lazy { WireMock(server.port()) }

    /** Starts the server (idempotent - a `by lazy` singleton) and returns its base URL. */
    fun start(): String {
        server.isRunning
        return baseUrl
    }

    val baseUrl: String get() = server.baseUrl()

    /** Resets every scenario back to `Started` - call between tests that touch `jira-day2`. */
    fun resetScenarios() = client.resetScenarios()

    fun setScenarioState(scenarioName: String, state: String) = client.setSingleScenarioState(scenarioName, state)

    /** Registers a one-off override mapping (e.g. forcing a 403/401 on one path) and returns it for later removal. */
    fun addOverride(stub: MappingBuilder): StubMapping = client.register(stub)

    fun removeOverride(mapping: StubMapping) = client.removeStubMapping(mapping)
}
