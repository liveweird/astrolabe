package ch.nokillswit

import ch.nokillswit.infra.outbound.FlowOrigins
import ch.nokillswit.infra.outbound.Origin
import ch.nokillswit.infra.outbound.SelfManagedHosts
import ch.nokillswit.infra.outbound.parseFlowInsecureOrigins
import ch.nokillswit.infra.outbound.parseSelfManagedHosts
import java.net.InetAddress
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The operator's Flow origin rule (`infra/outbound/FlowOrigins.kt`, `.claude/docs/security.md` "The Flow consumer"): a listed `https`
 * host, the development-only plain-http origins, the production refusal, the loopback allowance of an insecure host and the CIDR rule.
 * Pure and offline: address literals only, no DNS.
 */
class FlowOriginsTest {
    private val listed = parseSelfManagedHosts(
        "flow.corp.example,flow2.corp.example:8443", "10.20.0.0/16", hostsKey = "flow.allowedHosts", cidrsKey = "flow.allowedCidrs",
    )
    private val insecure = parseFlowInsecureOrigins("http://flow-stub:8080, http://host.docker.internal:8084", "flow.insecureOrigins")

    private fun origins(dev: Boolean = true, withListed: Boolean = true, withInsecure: Boolean = true) = FlowOrigins(
        if (withListed) listed else SelfManagedHosts.NONE, if (withInsecure) insecure else emptySet(), dev,
    )

    private fun ip(literal: String): InetAddress = InetAddress.getByName(literal)

    // --- a listed https host ---

    @Test
    fun `a listed https host is allowed on its listed port only, over https only`() {
        val o = origins(dev = false)
        assertTrue(o.hostAllowed("flow.corp.example"))
        assertTrue(o.hostAllowed("FLOW.corp.example"), "host names are case-insensitive")
        assertTrue(o.originAllowed("https", "flow.corp.example", 443))
        assertTrue(o.originAllowed("https", "flow2.corp.example", 8443))
        assertFalse(o.originAllowed("https", "flow2.corp.example", 443), "a host:port entry means that port only")
        assertFalse(o.originAllowed("https", "flow.corp.example", 8443))
        assertFalse(o.originAllowed("http", "flow.corp.example", 80), "plain http to a listed TLS host")
        assertFalse(o.originAllowed("http", "flow.corp.example", 443), "http on 443")
        assertFalse(o.hostAllowed("evil.example.com"))
        assertFalse(o.originAllowed("https", "evil.example.com", 443))
    }

    @Test
    fun `nothing is reachable until something is listed`() {
        val none = FlowOrigins.NONE
        assertFalse(none.hostAllowed("flow.corp.example"))
        assertFalse(none.originAllowed("https", "flow.corp.example", 443))
        assertFalse(none.baseUrlAllowed("https://flow.corp.example"))
        val insecureOnly = origins(dev = false, withListed = false)
        assertFalse(insecureOnly.hostAllowed("flow-stub"), "an insecure list alone reaches nothing in production")
        assertFalse(insecureOnly.baseUrlAllowed("http://flow-stub:8080"))
    }

    // --- development-only plain http ---

    @Test
    fun `an insecure http origin is allowed in development, exactly itself`() {
        val o = origins()
        assertTrue(o.hostAllowed("flow-stub"))
        assertTrue(o.originAllowed("http", "flow-stub", 8080))
        assertTrue(o.originAllowed("http", "FLOW-STUB", 8080))
        assertTrue(o.originAllowed("http", "host.docker.internal", 8084))
        assertFalse(o.originAllowed("http", "flow-stub", 8081), "another port")
        assertFalse(o.originAllowed("https", "flow-stub", 8080), "another scheme")
        assertFalse(o.originAllowed("http", "other-host", 8080))
        assertFalse(o.originAllowed("http", "flow-stub", 80), "the port is part of the entry")
    }

    @Test
    fun `production never honours an insecure origin, even when one is somehow listed`() {
        val o = origins(dev = false)
        assertFalse(o.hostAllowed("flow-stub"))
        assertFalse(o.originAllowed("http", "flow-stub", 8080))
        assertFalse(o.baseUrlAllowed("http://flow-stub:8080"))
        assertFalse(o.addressAllowed("flow-stub", ip("127.0.0.1")))
    }

    @Test
    fun `an insecure host may resolve to a loopback or docker address in development only`() {
        val dev = origins()
        for (address in listOf("127.0.0.1", "::1", "172.17.0.5", "192.168.65.254", "10.43.1.7")) {
            assertTrue(dev.addressAllowed("flow-stub", ip(address)), "$address for the insecure host in development")
            assertFalse(dev.addressAllowed("other-host", ip(address)), "$address for any other host")
            assertFalse(origins(dev = false).addressAllowed("flow-stub", ip(address)), "$address in production")
        }
    }

    @Test
    fun `an insecure host is refused the address classes no host may have, and still allowed the local ones`() {
        val dev = origins()
        val never = listOf(
            "169.254.169.254", "169.254.1.1", "0.0.0.0", "0.1.2.3", "224.0.0.1", "ff02::1", "::", "2002::1", "2001:0::1", "fe80::1",
        )
        for (address in never) {
            assertFalse(dev.addressAllowed("flow-stub", ip(address)), "$address for the insecure host in development")
        }
        for (address in listOf("127.0.0.1", "::1", "172.18.0.5", "198.19.0.1", "10.43.1.7", "192.168.65.254", "93.184.216.34")) {
            assertTrue(dev.addressAllowed("flow-stub", ip(address)), address)
        }
    }

    @Test
    fun `a host that is both listed over TLS and insecure follows the listed rule only`() {
        val alias = parseFlowInsecureOrigins("http://flow.corp.example:8080", "flow.insecureOrigins")
        val both = FlowOrigins(listed, alias, developmentMode = true)
        assertTrue(both.originAllowed("http", "flow.corp.example", 8080), "the origin is still listed")
        assertFalse(both.addressAllowed("flow.corp.example", ip("127.0.0.1")), "loopback belongs to the insecure branch only")
        assertTrue(both.addressAllowed("flow.corp.example", ip("10.20.1.5")), "a CIDR address follows the listed rule")
        assertEquals("https", both.schemeFor("flow.corp.example"))
    }

    @Test
    fun `the scheme audited for a refusal is the one the host would have used`() {
        assertEquals("http", origins().schemeFor("flow-stub"))
        assertEquals("https", origins(dev = false).schemeFor("flow-stub"))
        assertEquals("https", origins().schemeFor("flow.corp.example"))
        assertEquals("https", origins().schemeFor("unlisted.example"))
    }

    // --- the CIDR rule ---

    @Test
    fun `a private address is allowed for a listed host inside a listed CIDR, nothing else`() {
        val o = origins(dev = false)
        assertTrue(o.addressAllowed("flow.corp.example", ip("10.20.1.5")))
        assertTrue(o.addressAllowed("flow2.corp.example", ip("10.20.255.254")))
        assertFalse(o.addressAllowed("flow.corp.example", ip("10.30.0.1")), "private but outside the CIDR")
        assertFalse(o.addressAllowed("flow.corp.example", ip("192.168.1.1")))
        assertFalse(o.addressAllowed("unlisted.example", ip("10.20.1.5")), "inside the CIDR but not a listed host")
        assertTrue(o.addressAllowed("flow.corp.example", ip("93.184.216.34")), "a public address needs no CIDR")
    }

    @Test
    fun `loopback and link-local are refused for a listed host whatever the CIDRs say`() {
        val o = origins(dev = false)
        for (address in listOf("127.0.0.1", "::1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "fe80::1")) {
            assertFalse(o.addressAllowed("flow.corp.example", ip(address)), address)
        }
    }

    // --- the registry's baseUrl ---

    @Test
    fun `a base URL is exactly a listed origin`() {
        val o = origins()
        for (url in listOf(
            "https://flow.corp.example", "https://flow2.corp.example:8443", "http://flow-stub:8080", "http://host.docker.internal:8084",
        )) {
            assertTrue(o.baseUrlAllowed(url), url)
        }
        val plain = FlowOrigins(listed, parseFlowInsecureOrigins("http://plain.test", "flow.insecureOrigins"), developmentMode = true)
        assertTrue(plain.baseUrlAllowed("http://plain.test"))
    }

    @Test
    fun `only the canonical spelling of a listed origin is accepted - lowercase, default port omitted`() {
        val o = FlowOrigins(listed, parseFlowInsecureOrigins("http://plain.test", "flow.insecureOrigins"), developmentMode = true)
        for (url in listOf(
            "HTTPS://flow.corp.example", "https://FLOW.corp.example", "https://flow.corp.example:443", "HTTPS://FLOW.corp.example:443",
            "http://flow-stub:8080".uppercase(), "http://Flow-Stub:8080", "http://plain.test:80", "HTTP://plain.test",
        )) {
            assertFalse(o.baseUrlAllowed(url), "must refuse the non-canonical form: \"$url\"")
        }
        // The same origins are still reachable per request, whatever the case: the transport judges the lowercase form OkHttp hands it.
        assertTrue(o.originAllowed("https", "FLOW.corp.example", 443))
    }

    @Test
    fun `a base URL with anything beyond the origin, or an unlisted one, is refused`() {
        val o = origins()
        for (url in listOf(
            "https://flow.corp.example/", "https://flow.corp.example/api", "https://flow.corp.example?x=1", "https://flow.corp.example#f",
            "https://user:pw@flow.corp.example", "https://flow.corp.example:", "http://flow.corp.example", "https://flow.corp.example:8443",
            "https://evil.example", "http://flow-stub:8081", "https://flow-stub:8080", "http://flow-stub", "ftp://flow-stub:8080",
            "flow-stub:8080", "//flow-stub:8080", "", " ", "not a url", "http:///x", "http://10.0.0.5:8080", "http://[::1]:8080",
            "http://127.0.0.1:8080", "https://flow.corp.example\n",
        )) {
            assertFalse(o.baseUrlAllowed(url), "must refuse: \"$url\"")
        }
    }

    // --- flow.insecureOrigins parsing ---

    @Test
    fun `insecure origins parse to exact http origins with a default port of 80`() {
        assertEquals(emptySet(), parseFlowInsecureOrigins("", "flow.insecureOrigins"))
        assertEquals(emptySet(), parseFlowInsecureOrigins("  ", "flow.insecureOrigins"))
        assertEquals(
            setOf(Origin("http", "flow-stub", 8080), Origin("http", "localhost", 80), Origin("http", "app.flow.svc.cluster.local", 8084)),
            parseFlowInsecureOrigins(
                "http://Flow-Stub:8080, HTTP://localhost,http://app.flow.svc.cluster.local:8084", "flow.insecureOrigins",
            ),
        )
    }

    @Test
    fun `a malformed insecure origin is refused naming the key, never the value`() {
        for (bad in listOf(
            "https://flow-stub:8080", "flow-stub:8080", "ftp://flow-stub", "http://", "http://flow-stub/path", "http://flow-stub?x=1",
            "http://flow-stub#f", "http://*.example.com", "http://10.0.0.5:8080", "http://[::1]:8080", "http://flow-stub:0",
            "http://flow-stub:65536", "http://flow-stub:abc", "http://a,,http://b", "http://flow-stub:8080,",
            "http://user:s3cret-pw@flow-stub:8080",
            "http://flow-stub:8080/?token=s3cret-pw",
        )) {
            val message = assertFailsWith<IllegalStateException>("must refuse: $bad") {
                parseFlowInsecureOrigins(bad, "flow.insecureOrigins")
            }.message.orEmpty()
            assertTrue("flow.insecureOrigins" in message, "the key is named: $message")
            assertFalse("s3cret-pw" in message, "a credential in an entry is never echoed: $message")
        }
    }
}
