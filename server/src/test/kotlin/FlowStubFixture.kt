package ch.nokillswit

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * The warm-up of [FlowStubServer]: the first start loads nine mappings and six bodies and the first request pays Jetty's and the
 * matcher's cold paths (and parses the 130 KB document), a cost that must land in a `@BeforeClass` (JUnit 4 does not time it), never
 * inside `testApplication`'s hard 60 s. A test class that touches [FlowStubServer] calls [warm] there; `StubWarmupGuardTest` fails a
 * class that forgets (the twin of [JiraStubFixture]).
 */
object FlowStubFixture {
    private var warmedUrl: String? = null

    /**
     * Idempotent per JVM: starts the stub, makes one authenticated `me` call and one `teams` call and prints the `flow-stub` marker;
     * returns the base URL.
     */
    @Synchronized
    fun warm(): String {
        warmedUrl?.let { return it }
        val startedAt = System.nanoTime()
        val url = FlowStubServer.start()
        val client = HttpClient.newHttpClient()
        fun status(path: String): Int {
            val request = HttpRequest.newBuilder(URI.create("$url$path")).timeout(Duration.ofSeconds(60)).GET()
                .header("Authorization", FlowStubServer.authorization).build()
            return client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode()
        }
        check(status(FlowStubServer.mePath) == 200) { "the Flow stub does not answer me" }
        check(status(FlowStubServer.teamsPath + FlowStubServer.defaultSinceQuery) == 200) { "the Flow stub does not answer teams" }
        // Fixture-cost marker (read by `scripts/timings/local-times.mjs`, which subtracts it from the suite that paid it).
        println("fixture-cost\tflow-stub\t${(System.nanoTime() - startedAt) / 1_000_000L}")
        warmedUrl = url
        return url
    }
}
