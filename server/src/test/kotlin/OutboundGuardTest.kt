package ch.nokillswit

import ch.nokillswit.infra.fetch.FetchException
import ch.nokillswit.infra.outbound.BlockedHostException
import ch.nokillswit.infra.outbound.GuardedDns
import ch.nokillswit.infra.outbound.isAllowedJiraHost
import ch.nokillswit.jira.buildGuardedJiraHttpClient
import ch.nokillswit.jira.createJiraHttp
import com.github.tomakehurst.wiremock.client.WireMock.aResponse
import com.github.tomakehurst.wiremock.client.WireMock.get
import com.github.tomakehurst.wiremock.client.WireMock.urlPathEqualTo
import io.ktor.http.HttpMethod
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import okhttp3.Call
import okhttp3.Connection
import okhttp3.EventListener
import org.junit.BeforeClass
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The outbound HTTP boundary (ported from Flow, where the Jira client was its consumer; `.claude/docs/security.md`
 * "Outbound HTTP calls"): the host allow-list ([isAllowedJiraHost]) as the primary boundary, and
 * [GuardedDns]'s address check (ported verbatim from Toadie's `isBlockedAddress`) as defense in
 * depth, with an injected resolver so every case is exact and offline. The "production wiring" cases at the end build the SAME client
 * `configureJira` wires ([buildGuardedJiraHttpClient]) and drive it through the real OkHttp engine against the loopback [JiraStubServer].
 */
class OutboundGuardTest {

    private fun ipv4(a: Int, b: Int, c: Int, d: Int): InetAddress =
        InetAddress.getByAddress(byteArrayOf(a.toByte(), b.toByte(), c.toByte(), d.toByte()))

    /** [hextets] are the 8 IPv6 groups (0..0xFFFF each) — safer than hand-counting a hex string. */
    private fun ipv6(vararg hextets: Int): InetAddress {
        require(hextets.size == 8)
        val bytes = ByteArray(16)
        hextets.forEachIndexed { i, h ->
            bytes[i * 2] = (h shr 8).toByte()
            bytes[i * 2 + 1] = (h and 0xFF).toByte()
        }
        return InetAddress.getByAddress(bytes)
    }

    @Test
    fun `allow-list accepts the gateway host and a genuine tenant, refuses reserved labels and other hosts`() {
        assertTrue(isAllowedJiraHost("api.atlassian.com", null, developmentMode = false))
        assertTrue(isAllowedJiraHost("acme-corp.atlassian.net", null, developmentMode = false))
        assertFalse(isAllowedJiraHost("api.atlassian.net", null, developmentMode = false), "a reserved label is not a genuine tenant")
        assertFalse(isAllowedJiraHost("evil.example.com", null, developmentMode = false))
        assertFalse(
            isAllowedJiraHost("169.254.169.254", null, developmentMode = false),
            "a raw metadata-service address is not a tenant host",
        )
    }

    @Test
    fun `the stub host is allowed ONLY in development, and only itself`() {
        assertFalse(isAllowedJiraHost("jira-stub", "jira-stub", developmentMode = false), "production never honours the stub host")
        assertTrue(isAllowedJiraHost("jira-stub", "jira-stub", developmentMode = true))
        assertFalse(isAllowedJiraHost("other-host", "jira-stub", developmentMode = true), "only the CONFIGURED stub host, not any host")
        assertFalse(isAllowedJiraHost("jira-stub", null, developmentMode = true), "a blank/unset stub host is never matched")
    }

    @Test
    fun `GuardedDns refuses a disallowed host WITHOUT ever resolving it`() {
        var resolved = false
        val dns = GuardedDns(allowedHost = { false }, resolver = { resolved = true; listOf(ipv4(8, 8, 8, 8)) })
        assertFailsWith<BlockedHostException> { dns.lookup("evil.example.com") }
        assertFalse(resolved, "an already-disallowed host must never reach the resolver")
    }

    /**
     * The EXACT class: [BlockedHostException] IS-A [UnknownHostException], so `assertFailsWith<UnknownHostException>`
     * alone cannot tell them apart.
     */
    private fun assertPlainDnsFailure(failure: Throwable, host: String) {
        assertEquals(UnknownHostException::class, failure::class, "a DNS failure must not be a BlockedHostException")
        assertFalse(failure is BlockedHostException)
        assertEquals(host, failure.message, "the message is the host only")
    }

    @Test
    fun `GuardedDns - an unresolvable allowed host is a plain UnknownHostException, not audited`() = runBlocking {
        val host = "dns-fail-${UUID.randomUUID()}.atlassian.net"
        withAuditCapture { audit ->
            val warnings = LogCapture("ch.nokillswit.outbound")
            try {
                val dns = GuardedDns(allowedHost = { true }, resolver = { throw UnknownHostException("resolver detail") })
                assertPlainDnsFailure(assertFailsWith<UnknownHostException> { dns.lookup(host) }, host)
                assertTrue(
                    audit.events.none { it.message == "outbound.blocked" && it.hasKeyValue("host", host) },
                    "a DNS failure is not a guard rejection",
                )
                val warning = warnings.events.single { it.formattedMessage.contains(host) }
                assertEquals(ch.qos.logback.classic.Level.WARN, warning.level)
                assertTrue(warnings.events.none { it.throwableProxy != null }, "host only, no stack trace")
            } finally {
                warnings.detach()
            }
        }
    }

    @Test
    fun `GuardedDns - an empty answer for an allowed host is a plain UnknownHostException, not audited`() = runBlocking {
        val host = "dns-empty-${UUID.randomUUID()}.atlassian.net"
        withAuditCapture { audit ->
            val dns = GuardedDns(allowedHost = { true }, resolver = { emptyList() })
            assertPlainDnsFailure(assertFailsWith<UnknownHostException> { dns.lookup(host) }, host)
            assertTrue(
                audit.events.none { it.message == "outbound.blocked" && it.hasKeyValue("host", host) },
                "an empty answer is not a guard rejection",
            )
        }
    }

    @Test
    fun `GuardedDns refuses every blocked address range, including IPv4-mapped IPv6`() {
        val blocked: List<Pair<String, InetAddress>> = listOf(
            "loopback" to ipv4(127, 0, 0, 1),
            "private 10-net" to ipv4(10, 0, 0, 1),
            "private 192.168-net" to ipv4(192, 168, 1, 1),
            "link-local" to ipv4(169, 254, 1, 1),
            "multicast" to ipv4(224, 0, 0, 1),
            "any-local (0.0.0.0)" to ipv4(0, 0, 0, 0),
            "this-network 0.0.0.0/8" to ipv4(0, 0, 0, 1),
            "this-network 0.255.255.254" to ipv4(0, 255, 255, 254),
            "reserved 240.0.0.0/4" to ipv4(240, 0, 0, 1),
            "reserved 254.1.2.3" to ipv4(254, 1, 2, 3),
            "limited broadcast 255.255.255.255" to ipv4(255, 255, 255, 255),
            "CGNAT 100.64/10" to ipv4(100, 64, 0, 1),
            "IETF protocol assignments 192.0.0/24" to ipv4(192, 0, 0, 1),
            "benchmarking 198.18/15" to ipv4(198, 18, 0, 1),
            "benchmarking 198.19/15" to ipv4(198, 19, 255, 254),
            "IPv6 loopback ::1" to ipv6(0, 0, 0, 0, 0, 0, 0, 1),
            "IPv6 unique-local fc00::/7" to ipv6(0xfc00, 0, 0, 0, 0, 0, 0, 1),
            "IPv6 unique-local fd00::/7" to ipv6(0xfd12, 0x3456, 0, 0, 0, 0, 0, 1),
            "IPv6 link-local fe80::/10" to ipv6(0xfe80, 0, 0, 0, 0, 0, 0, 1),
            "6to4 2002::/16 embedding a public IPv4" to ipv6(0x2002, 0xcb00, 0x710a, 0, 0, 0, 0, 1),
            "Teredo 2001:0::/32" to ipv6(0x2001, 0, 0x4136, 0xe378, 0x8000, 0x63bf, 0x3fff, 0xfdd2),
            "IPv4-mapped IPv6 loopback ::ffff:127.0.0.1" to ipv6(0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001),
            "IPv4-mapped IPv6 private ::ffff:10.0.0.1" to ipv6(0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001),
            "NAT64 64:ff9b::/96 embedding a private IPv4" to ipv6(0x0064, 0xff9b, 0, 0, 0, 0, 0xc0a8, 0x0101),
            "NAT64 local-use 64:ff9b:1::/48 embedding a PUBLIC IPv4" to ipv6(0x0064, 0xff9b, 0x0001, 0, 0, 0, 0x0808, 0x0808),
            "NAT64 local-use 64:ff9b:1:ffff::" to ipv6(0x0064, 0xff9b, 0x0001, 0, 0xffff, 0xffff, 0xffff, 0xffff),
            "IPv4-mapped IPv6 broadcast ::ffff:255.255.255.255" to ipv6(0, 0, 0, 0, 0, 0xffff, 0xffff, 0xffff),
        )
        blocked.forEach { (label, address) ->
            val dns = GuardedDns(allowedHost = { true }, resolver = { listOf(address) })
            assertFailsWith<BlockedHostException>("expected $label to be blocked") { dns.lookup("api.atlassian.com") }
        }
    }

    /** An `Inet6Address` holding IPv4-mapped bytes: `getByName` folds the literal into an `Inet4Address`, this constructor does not. */
    private fun rawMapped(a: Int, b: Int, c: Int, d: Int): InetAddress {
        val bytes = ByteArray(16).also {
            it[10] = 0xFF.toByte()
            it[11] = 0xFF.toByte()
            it[12] = a.toByte(); it[13] = b.toByte(); it[14] = c.toByte(); it[15] = d.toByte()
        }
        return java.net.Inet6Address.getByAddress(null, bytes, 0)
    }

    @Test
    fun `GuardedDns refuses an unfolded IPv4-mapped Inet6Address by its IPv4 form, and accepts a public one`() {
        val blocked = listOf(rawMapped(127, 0, 0, 1), rawMapped(10, 0, 0, 1), rawMapped(169, 254, 169, 254), rawMapped(192, 168, 1, 1))
        blocked.forEach { address ->
            assertTrue(address is java.net.Inet6Address, "the fixture must stay an unfolded Inet6Address")
            val dns = GuardedDns(allowedHost = { true }, resolver = { listOf(address) })
            assertFailsWith<BlockedHostException>("expected ${address.hostAddress} to be blocked") { dns.lookup("api.atlassian.com") }
        }
        val public = GuardedDns(allowedHost = { true }, resolver = { listOf(rawMapped(203, 0, 113, 10)) })
        assertEquals(1, public.lookup("api.atlassian.com").size)
    }

    @Test
    fun `the address rule is injectable - the default is public addresses only, a custom one decides per host and address`() {
        val seen = mutableListOf<Pair<String, InetAddress>>()
        val allowEverythingForOneHost = GuardedDns(
            allowedHost = { true },
            resolver = { listOf(ipv4(10, 0, 0, 1)) },
            addressAllowed = { host, address -> seen += host to address; host == "stub-host" },
        )
        assertEquals(1, allowEverythingForOneHost.lookup("stub-host").size)
        assertFailsWith<BlockedHostException> { allowEverythingForOneHost.lookup("api.atlassian.com") }
        assertEquals(listOf("stub-host", "api.atlassian.com"), seen.map { it.first })
        assertFailsWith<BlockedHostException> { GuardedDns(allowedHost = { true }, resolver = { listOf(ipv4(10, 0, 0, 1)) }).lookup("any") }
    }

    @Test
    fun `GuardedDns accepts a genuinely public address`() {
        val dns = GuardedDns(allowedHost = { true }, resolver = { listOf(ipv4(203, 0, 113, 10)) })
        assertEquals(1, dns.lookup("api.atlassian.com").size)
    }

    @Test
    fun `GuardedDns refuses if ANY resolved address in a multi-address answer is blocked`() {
        val dns = GuardedDns(allowedHost = { true }, resolver = { listOf(ipv4(203, 0, 113, 10), ipv4(127, 0, 0, 1)) })
        assertFailsWith<BlockedHostException> { dns.lookup("api.atlassian.com") }
    }

    // --- Production-wiring cases: [buildGuardedJiraHttpClient] builds EXACTLY the Ktor `HttpClient(OkHttp)` `jira/Jira.kt`'s
    // `configureJira()` wires, driven against the real, loopback [JiraStubServer] through the REAL OkHttp engine. ---

    private fun jiraHttp(client: io.ktor.client.HttpClient, maxRetries: Int, sleeper: suspend (Long) -> Unit = {}) =
        createJiraHttp(client, maxRetries = maxRetries, maxResponseBytes = 1_000_000, maxConcurrentRequests = 4, sleeper = sleeper)

    @Test
    fun `production wiring - an allowed host resolving to a blocked address is BLOCKED_HOST, one attempt, no retry`() = runBlocking {
        val stubUrl = JiraStubServer.start()
        var resolveCalls = 0
        val httpClient = buildGuardedJiraHttpClient(
            originAllowed = null,
            allowedHost = { true },
            resolver = { resolveCalls++; InetAddress.getAllByName(it).toList() },
            requestTimeoutSeconds = 5,
        )
        // Mutation check: revert BlockedHostException to a bare RuntimeException and this becomes UPSTREAM_UNAVAILABLE after 3 resolver
        // calls (real backoff) instead - OkHttp re-wraps a non-IOException thrown out of the interceptor chain.
        val error = assertFailsWith<FetchException> {
            jiraHttp(httpClient, maxRetries = 2).request(HttpMethod.Get, "$stubUrl/_edge/tenant_info")
        }
        assertEquals("BLOCKED_HOST", error.code)
        assertEquals(1, resolveCalls, "BLOCKED_HOST must not be retried")
    }

    @Test
    fun `production wiring - a DNS failure is retried and the call succeeds once the resolver answers`() = runBlocking {
        val stubUrl = JiraStubServer.start()
        var resolveCalls = 0
        val httpClient = buildGuardedJiraHttpClient(
            originAllowed = null,
            allowedHost = { true },
            resolver = { host -> if (resolveCalls++ == 0) throw UnknownHostException(host) else InetAddress.getAllByName(host).toList() },
            // The stub is loopback by construction (the `jira.stubBaseUrl` convention): skip the address-SHAPE check only.
            addressAllowed = { _, _ -> true },
            requestTimeoutSeconds = 5,
        )
        val result = jiraHttp(httpClient, maxRetries = 2).request(HttpMethod.Get, "$stubUrl/_edge/tenant_info")
        assertTrue(result.toString().contains("cloudId"), "expected the real tenant_info stub body: $result")
        assertEquals(2, resolveCalls, "the failed lookup, then the retry's re-resolution")
    }

    @Test
    fun `production wiring - a persistent DNS failure is UPSTREAM_UNAVAILABLE, never BLOCKED_HOST`() = runBlocking {
        val downHost = "dns-down.atlassian.net"
        var resolveCalls = 0
        val sleeps = mutableListOf<Long>()
        val httpClient = buildGuardedJiraHttpClient(
            originAllowed = null,
            allowedHost = { true },
            resolver = { host -> resolveCalls++; throw UnknownHostException(host) },
            requestTimeoutSeconds = 5,
        )
        withAuditCapture { audit ->
            val error = assertFailsWith<FetchException> {
                jiraHttp(httpClient, maxRetries = 2) { sleeps += it }.request(HttpMethod.Get, "https://$downHost/_edge/tenant_info")
            }
            assertEquals("UPSTREAM_UNAVAILABLE", error.code)
            assertEquals(3, resolveCalls, "the first attempt plus maxRetries retries")
            assertEquals(2, sleeps.size, "one backoff per retry")
            assertFalse(
                audit.events.any { it.message == "outbound.blocked" && it.hasKeyValue("host", downHost) },
                "a DNS failure is not a guard rejection",
            )
        }
    }

    @Test
    fun `production wiring - a disallowed host is BLOCKED_HOST without ever invoking the resolver`() = runBlocking {
        var resolveCalls = 0
        val httpClient = buildGuardedJiraHttpClient(
            originAllowed = null,
            allowedHost = { false },
            resolver = { resolveCalls++; listOf(InetAddress.getByName("203.0.113.10")) },
            requestTimeoutSeconds = 5,
        )
        val error = assertFailsWith<FetchException> {
            jiraHttp(httpClient, maxRetries = 2).request(HttpMethod.Get, "https://evil.example.com/probe")
        }
        assertEquals("BLOCKED_HOST", error.code)
        assertEquals(0, resolveCalls, "an already-disallowed host must never reach the resolver")
    }

    @Test
    fun `production wiring - a 3xx from the real OkHttp engine is REDIRECT, never followed`() = runBlocking {
        val stubUrl = JiraStubServer.start()
        val redirectPath = "/probe-redirect-${UUID.randomUUID()}"
        val override = JiraStubServer.addOverride(
            get(urlPathEqualTo(redirectPath)).willReturn(aResponse().withStatus(302).withHeader("Location", "https://evil.example/")),
        )
        try {
            val httpClient = buildGuardedJiraHttpClient(
                originAllowed = null,
                allowedHost = { true },
                addressAllowed = { _, _ -> true },
                requestTimeoutSeconds = 5,
            )
            val error = assertFailsWith<FetchException> {
                jiraHttp(httpClient, maxRetries = 0).request(HttpMethod.Get, "$stubUrl$redirectPath")
            }
            assertEquals("REDIRECT", error.code)
        } finally {
            JiraStubServer.removeOverride(override)
        }
    }

    @Test
    fun `production wiring - ignores a configured system proxy (Proxy_NO_PROXY)`() = runBlocking {
        val stubUrl = JiraStubServer.start()
        val originalHost = System.getProperty("http.proxyHost")
        val originalPort = System.getProperty("http.proxyPort")
        // An unroutable proxy target: if the guarded client honoured it, the call would fail instead of reaching the loopback stub
        // directly.
        System.setProperty("http.proxyHost", "203.0.113.10")
        System.setProperty("http.proxyPort", "1")
        try {
            val httpClient = buildGuardedJiraHttpClient(
                originAllowed = null, allowedHost = { true }, addressAllowed = { _, _ -> true }, requestTimeoutSeconds = 5,
            )
            val result = jiraHttp(httpClient, maxRetries = 0).request(HttpMethod.Get, "$stubUrl/_edge/tenant_info")
            assertTrue(result.toString().contains("cloudId"), "expected the real tenant_info stub body: $result")
        } finally {
            originalHost?.let { System.setProperty("http.proxyHost", it) } ?: System.clearProperty("http.proxyHost")
            originalPort?.let { System.setProperty("http.proxyPort", it) } ?: System.clearProperty("http.proxyPort")
        }
    }

    /** Counts OkHttp's own connection-pool checkout/checkin events - the leak signal. */
    private class CountingEventListener : EventListener() {
        val acquired = AtomicInteger(0)
        val released = AtomicInteger(0)
        override fun connectionAcquired(call: Call, connection: Connection) {
            acquired.incrementAndGet()
        }
        override fun connectionReleased(call: Call, connection: Connection) {
            released.incrementAndGet()
        }
    }

    @Test
    fun `every attempt releases its OkHttp connection back to the pool, even on repeated failures`() = runBlocking {
        val stubUrl = JiraStubServer.start()
        val failPath = "/probe-fail-${UUID.randomUUID()}"
        // A body large enough that OkHttp must STREAM it off the socket: only then does an unread body keep the connection checked out.
        val override = JiraStubServer.addOverride(
            get(urlPathEqualTo(failPath)).willReturn(aResponse().withStatus(503).withBody("x".repeat(2 * 1024 * 1024))),
        )
        val listener = CountingEventListener()
        try {
            val httpClient = buildGuardedJiraHttpClient(
                originAllowed = null, allowedHost = { true }, addressAllowed = { _, _ -> true }, requestTimeoutSeconds = 5,
                eventListener = listener,
            )
            assertFailsWith<FetchException> { jiraHttp(httpClient, maxRetries = 2).request(HttpMethod.Get, "$stubUrl$failPath") }
            assertTrue(listener.acquired.get() >= 3, "the initial attempt plus 2 retries: ${listener.acquired.get()}")
            assertEquals(listener.acquired.get(), listener.released.get(), "no leaked connections after repeated failures")
        } finally {
            JiraStubServer.removeOverride(override)
        }
    }

    @Test
    fun `a blocked stub host is audited with its REAL scheme, not a hardcoded https`() = runBlocking {
        withAuditCapture { capture ->
            val dns = GuardedDns(allowedHost = { false }, schemeFor = { "http" })
            assertFailsWith<BlockedHostException> { dns.lookup("jira-stub") }
            val event = capture.awaitEvent { it.message == "outbound.blocked" && it.hasKeyValue("scheme", "http") }
            assertNotNull(event, "expected outbound.blocked audited with the real (http) scheme, not a hardcoded https")
            Unit
        }
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun warmStub() {
            JiraStubFixture.warm()
        }
    }
}
