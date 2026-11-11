package ch.nokillswit

import com.github.tomakehurst.wiremock.WireMockServer
import com.github.tomakehurst.wiremock.client.MappingBuilder
import com.github.tomakehurst.wiremock.client.WireMock
import com.github.tomakehurst.wiremock.core.WireMockConfiguration
import com.github.tomakehurst.wiremock.verification.LoggedRequest
import com.github.tomakehurst.wiremock.matching.RequestPatternBuilder
import com.github.tomakehurst.wiremock.stubbing.StubMapping
import java.io.File

/**
 * The shape of every shared in-JVM WireMock of the server suite: ONE lazily started server per JVM over a generated stub directory
 * (`sample-data/<name>-stub`), the SAME mappings and `__files` the compose and Kubernetes image serves, so the suite exercises a
 * client against the generator-fixed contract rather than a second, hand-rolled fixture that could drift from it. Shared across the
 * whole suite like [PostgresTestSupport]; a test class that reads one warms it first (`JiraStubFixture.warm()`,
 * `FlowStubFixture.warm()`, `StubWarmupGuardTest`). The two singletons are [JiraStubServer] and [FlowStubServer].
 *
 * @param stubDirectory the repository-relative directory holding `mappings/` and `__files/`.
 */
open class StubServer(private val stubDirectory: String) {
    private val stubRoot: File by lazy {
        listOf(File(stubDirectory), File("../$stubDirectory"))
            .firstOrNull { it.isDirectory }
            ?: error("$stubDirectory not found from ${File(".").absolutePath}")
    }

    private val server: WireMockServer by lazy {
        WireMockServer(
            WireMockConfiguration.options()
                .usingFilesUnderDirectory(stubRoot.absolutePath)
                .dynamicPort()
                // WireMock keeps the journal unbounded by default - every served request WITH its response body, for the whole suite's
                // lifetime in this shared singleton (Flow's 512 MiB test JVM ran out of heap on it). Only [countRequests] reads it, right
                // after a [resetRequests], so the newest few entries are all it ever needs.
                .maxRequestJournalEntries(JOURNAL_ENTRIES),
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

    /** Resets every scenario back to `Started` - call between tests that touch a scenario (`jira-day2`, `flow-day2`, `flow-outage`). */
    fun resetScenarios() = client.resetScenarios()

    fun setScenarioState(scenarioName: String, state: String) = client.setSingleScenarioState(scenarioName, state)

    /** Registers a one-off override mapping (e.g. forcing a 403/401 on one path) and returns it for later removal. */
    fun addOverride(stub: MappingBuilder): StubMapping = client.register(stub)

    fun removeOverride(mapping: StubMapping) = client.removeStubMapping(mapping)

    /** Forgets the journal: call just before the interaction a [countRequests] will judge. */
    fun resetRequests() = client.resetRequests()

    /** How many requests the journal holds for [pattern] (at most [JOURNAL_ENTRIES] are kept, newest first). */
    fun countRequests(pattern: RequestPatternBuilder): Int = client.find(pattern).size

    /**
     * The journal's requests for [pattern], oldest first (the journal is newest first; a tie on the millisecond keeps that order
     * reversed): a test that asserts WHAT was asked and in what order. Call [resetRequests] just before the interaction.
     */
    fun requests(pattern: RequestPatternBuilder): List<LoggedRequest> = client.find(pattern).reversed().sortedBy { it.loggedDate }

    private companion object {
        const val JOURNAL_ENTRIES = 50
    }
}
