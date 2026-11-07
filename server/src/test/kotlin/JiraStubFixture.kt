package ch.nokillswit

import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * The warm-up of [JiraStubServer]: the first start loads ~1,600 mappings and ~1,570 bodies and the first request pays Jetty's and the
 * matcher's cold paths, a cost that must land in a `@BeforeClass` (JUnit 4 does not time it), never inside `testApplication`'s hard 60 s.
 * A test class that touches [JiraStubServer] calls [warm] there; `JiraStubWarmupGuardTest` fails a class that forgets (the pair is Flow's
 * `SyncedStubFixture` / `StubFixtureWarmupGuardTest`, cut to what a stub without a synced database needs).
 */
object JiraStubFixture {
    private var warmedUrl: String? = null

    /**
     * Idempotent per JVM: starts the stub, makes one unauthenticated and one authenticated request and prints the `jira-stub` marker;
     * returns the base URL.
     */
    @Synchronized
    fun warm(): String {
        warmedUrl?.let { return it }
        val startedAt = System.nanoTime()
        val url = JiraStubServer.start()
        val client = HttpClient.newHttpClient()
        fun status(path: String, authorization: String?): Int {
            val request = HttpRequest.newBuilder(URI.create("$url$path")).timeout(Duration.ofSeconds(60)).GET().apply {
                authorization?.let { header("Authorization", it) }
            }.build()
            return client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode()
        }
        check(status("/_edge/tenant_info", null) == 200) { "the Jira stub does not answer tenant_info" }
        val myself = "/ex/jira/${JiraStubServer.CLOUD_ID}/rest/api/3/myself"
        check(status(myself, "Bearer warm-up") == 200) { "the Jira stub does not answer myself" }
        // Fixture-cost marker (read by `scripts/timings/local-times.mjs`, which subtracts it from the suite that paid it).
        println("fixture-cost\tjira-stub\t${(System.nanoTime() - startedAt) / 1_000_000L}")
        warmedUrl = url
        return url
    }
}
