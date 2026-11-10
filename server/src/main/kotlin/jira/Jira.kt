package ch.nokillswit.jira

import ch.nokillswit.infra.config.requireConfigInt
import ch.nokillswit.infra.config.requireConfigLong
import ch.nokillswit.infra.db.R2dbcDatabaseKey
import ch.nokillswit.infra.fetch.OutboundPermits
import ch.nokillswit.infra.outbound.Origin
import ch.nokillswit.infra.outbound.guardedKtorClient
import ch.nokillswit.infra.outbound.guardedOkHttpClient
import ch.nokillswit.infra.outbound.isAllowedJiraHost
import ch.nokillswit.infra.outbound.isAllowedJiraOrigin
import ch.nokillswit.infra.outbound.isDevelopmentFixtureAddress
import ch.nokillswit.infra.outbound.publicAddressesOnly
import ch.nokillswit.sync.SyncConnectorsKey
import ch.nokillswit.sync.SyncRunServiceKey
import io.ktor.client.HttpClient
import io.ktor.server.application.*
import io.ktor.util.AttributeKey
import okhttp3.EventListener
import org.slf4j.LoggerFactory
import java.net.InetAddress
import java.net.URI
import java.net.URISyntaxException

private val log = LoggerFactory.getLogger("ch.nokillswit.jira")

val JiraConnectorKey = AttributeKey<JiraConnector>("JiraConnector")

/** The shared guarded client - published so a test can assert it is closed on [ApplicationStopped]. */
val JiraHttpClientKey = AttributeKey<HttpClient>("JiraHttpClient")

/**
 * Wires the Jira HTTP stack (Flow's `jira/Jira.kt`, trimmed): ONE guarded `HttpClient(OkHttp)` shared by every connection - the allow-list
 * ([isAllowedJiraHost]) checks the GENERAL tenant-host shape (`infra/outbound/AtlassianSites.kt`, one source of truth with the write-time
 * validation), not a single stored site, so a single long-lived client safely serves every connection row. `jira.stubBaseUrl` reroutes BOTH
 * hosts (tenant_info and gateway) of a `stub-` site ([JiraStubRouting]) to the Jira stub, and of NO other site - development mode ONLY;
 * production refuses a non-blank value at boot
 * (fail-closed, the shape of `infra/crypto/Crypto.kt`'s and `infra/mail/Mail.kt`'s checks). Registered in `application.yaml` after the
 * database and the plan routes, before the Jira routes.
 */
fun Application.configureJira() {
    val config = environment.config
    val stubBaseUrl = config.propertyOrNull("jira.stubBaseUrl")?.getString()?.trim().orEmpty().ifBlank { null }
    if (!developmentMode && stubBaseUrl != null) {
        error("Config \"jira.stubBaseUrl\" must be blank outside development mode (a stub must never be reachable in production)")
    }
    val requestTimeoutSeconds = requireConfigLong(config, "jira.requestTimeoutSeconds", MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)
    val requestDeadlineSeconds = requireConfigLong(config, "jira.requestDeadlineSeconds", MIN_DEADLINE_SECONDS, MAX_DEADLINE_SECONDS)
    val maxResponseBytes = requireConfigLong(config, "jira.maxResponseBytes", MIN_RESPONSE_BYTES, MAX_RESPONSE_BYTES)
    val maxConcurrentRequests = requireConfigInt(config, "jira.maxConcurrentRequests", MIN_CONCURRENCY, MAX_CONCURRENCY)
    val maxRetries = requireConfigInt(config, "jira.maxRetries", MIN_RETRIES, MAX_RETRIES)
    val pageSize = requireConfigInt(config, "jira.pageSize", MIN_PAGE_SIZE, MAX_PAGE_SIZE)
    val overlapMinutes = requireConfigLong(config, "jira.incrementalOverlapMinutes", MIN_OVERLAP_MINUTES, MAX_OVERLAP_MINUTES)
    val censusHours = requireConfigInt(config, "jira.censusHours", MIN_CENSUS_HOURS, MAX_CENSUS_HOURS)
    requireHeapFitsJiraCeilings(maxResponseBytes, maxConcurrentRequests)
    val stub = stubBaseUrl?.let(::validatedStubOrigin)
    val stubHost = stub?.host

    val httpClient = buildGuardedJiraHttpClient(
        allowedHost = { host -> isAllowedJiraHost(host, stubHost, developmentMode) },
        addressAllowed = jiraAddressRule(developmentMode, stubHost),
        // The stub may be plain http:// (the compose demo) - audit its real scheme rather than the https constant that is correct for
        // every genuine Jira Cloud host.
        schemeFor = { host ->
            if (developmentMode && stub != null && host.equals(stubHost, ignoreCase = true)) stub.scheme else "https"
        },
        // The transport-level rule (JiraBootTest pins this wiring): https:443 to an allowed Jira host, or the dev stub's exact origin. It
        // also refuses an IP-literal URL, which OkHttp never hands to the DNS guard.
        originAllowed = { scheme, host, port -> isAllowedJiraOrigin(scheme, host, port, stub, developmentMode) },
        requestTimeoutSeconds = requestTimeoutSeconds,
    )
    // ONE long-lived client for the app's whole life: closing it on ApplicationStopped releases the OkHttp dispatcher/connection-pool
    // threads (a stopped Application otherwise leaks them - the test suite starts and stops hundreds).
    attributes.put(JiraHttpClientKey, httpClient)
    monitor.subscribe(ApplicationStopped) { httpClient.close() }
    val permits = OutboundPermits(maxConcurrentRequests)
    val jiraHttp = createJiraHttp(
        httpClient, maxRetries, maxResponseBytes, maxConcurrentRequests,
        requestDeadlineMillis = requestDeadlineSeconds * MILLIS_PER_SECOND, permits = permits,
    )
    val routing = JiraStubRouting(stub, developmentMode)
    attributes.put(JiraStubRoutingKey, routing)
    val connector = JiraConnector(
        newClient = jiraClientFactory(jiraHttp, routing),
        pageSize = pageSize,
        incrementalOverlapMinutes = overlapMinutes,
        censusHours = censusHours,
        routedToStub = routing::routes,
    )
    attributes.put(JiraConnectorKey, connector)
    // The run: the Jira connector of the sync registry (`sync/`), registered here and started by `configureSync`'s routes. The services it
    // reads were published by `configureDatabase`, which runs before this module.
    val observer = JiraObserver(
        connector, attributes[JiraConnectionServiceKey], JiraRunStore(attributes[R2dbcDatabaseKey]),
        JiraIssueStore(attributes[R2dbcDatabaseKey]), attributes[SyncRunServiceKey],
    )
    attributes.put(JiraObserverKey, observer)
    attributes[SyncConnectorsKey].register(observer)
    // The host only, never the URL.
    log.info("Jira outbound wired (gateway {}{})", "api.atlassian.com", stubHost?.let { ", development stub host $it" }.orEmpty())
}

/**
 * The address rule of the Jira client. The stub is a local compose/in-JVM fixture BY DESIGN (see GuardedDns's kdoc) - its address is
 * expected to be loopback/private, unlike a genuine Jira Cloud host - but never link-local, any-local, multicast, `0.0.0.0/8`,
 * `::/96`, `::ffff:0:0:0/96`, a NAT64 prefix embedding a refused address or another tunnelling prefix
 * ([isDevelopmentFixtureAddress], Flow's rule for its insecure origins). The stub host is judged by that rule ALONE (the public-only
 * rule would refuse its loopback/private address). Every other host: public addresses only.
 */
internal fun jiraAddressRule(developmentMode: Boolean, stubHost: String?): (String, InetAddress) -> Boolean = { host, address ->
    if (developmentMode && stubHost != null && host.equals(stubHost, ignoreCase = true)) {
        address.isDevelopmentFixtureAddress()
    } else {
        publicAddressesOnly(host, address)
    }
}

/**
 * `jira.stubBaseUrl` as an [Origin]: `http(s)://host[:port]` and nothing else (no path, query, fragment or credentials), or the boot
 * is refused naming the key - never the value. The Jira stub is where the authenticated traffic goes in development, so a value
 * with a path or credentials would be a second way to steer it.
 */
internal fun validatedStubOrigin(value: String): Origin {
    val uri = try {
        URI(value)
    } catch (_: URISyntaxException) {
        null
    }
    val scheme = uri?.scheme?.lowercase()
    val valid = uri != null && (scheme == "http" || scheme == "https") && !uri.host.isNullOrBlank() &&
        uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && uri.rawPath.orEmpty() in setOf("", "/")
    check(valid) { "Config \"jira.stubBaseUrl\" must be an http(s) origin without path, query, fragment or credentials" }
    checkNotNull(uri)
    checkNotNull(scheme)
    val host = uri.host.lowercase()
    checkStubLiteral(host)
    return Origin(scheme, host, if (uri.port != -1) uri.port else if (scheme == "https") HTTPS_PORT else HTTP_PORT)
}

/**
 * OkHttp never hands an IP-literal host to DNS (any host of digits and dots, or with a colon, is dialled as a literal), so the address
 * rule would never see it: a literal is judged here, once. An IPv6 literal is refused outright (the per-request origin check compares
 * the bracketless host OkHttp sees, so it could never be reached); a numeric host must be a canonical dotted quad (the JDK also reads
 * `2852039166` or `0169.254.169.254` as 169.254.169.254) of a class [isDevelopmentFixtureAddress] admits (never link-local,
 * any-local, multicast, `0.0.0.0/8`, `::/96`, `::ffff:0:0:0/96` or a NAT64/tunnelling prefix). Every failure names the key, never
 * the value.
 */
private fun checkStubLiteral(host: String) {
    if (host.startsWith("[") || ':' in host) {
        error("Config \"jira.stubBaseUrl\" must name its host or an IPv4 address; an IPv6 literal is not supported")
    }
    if (host.all { it.isDigit() || it == '.' }) {
        val address = runCatching { InetAddress.getByName(host) }.getOrNull()
        check(address != null && address.hostAddress == host && address.isDevelopmentFixtureAddress()) {
            "Config \"jira.stubBaseUrl\" must not be an IP literal of a never-admitted class (link-local, any-local, multicast, 0/8, ...)"
        }
    }
}

/**
 * Builds EXACTLY the guarded Ktor `HttpClient(OkHttp)` [configureJira] wires into production - factored out so a test can build the SAME
 * client (not a hand-rolled approximation that could silently drift if the guard were ever unwired) and drive it against a real loopback
 * WireMock fixture (`OutboundGuardTest`'s production-wiring cases). [originAllowed] has no default, so every caller states it: null (no
 * per-request origin check) only in those loopback tests; [configureJira] always passes the real rule.
 */
fun buildGuardedJiraHttpClient(
    allowedHost: (String) -> Boolean,
    resolver: (String) -> List<InetAddress> = { InetAddress.getAllByName(it).toList() },
    addressAllowed: (String, InetAddress) -> Boolean = publicAddressesOnly,
    schemeFor: (String) -> String = { "https" },
    eventListener: EventListener = EventListener.NONE,
    originAllowed: ((scheme: String, host: String, port: Int) -> Boolean)?,
    requestTimeoutSeconds: Long,
): HttpClient {
    val okHttpClient = guardedOkHttpClient(
        allowedHost = allowedHost,
        resolver = resolver,
        timeoutSeconds = requestTimeoutSeconds,
        addressAllowed = addressAllowed,
        schemeFor = schemeFor,
        eventListener = eventListener,
        originAllowed = originAllowed,
    )
    return guardedKtorClient(okHttpClient, requestTimeoutSeconds)
}

private const val MIN_TIMEOUT_SECONDS = 5L
private const val MAX_TIMEOUT_SECONDS = 120L
private const val MIN_DEADLINE_SECONDS = 10L
private const val MAX_DEADLINE_SECONDS = 600L
private const val MIN_RESPONSE_BYTES = 65_536L
private const val MAX_RESPONSE_BYTES = 16L * 1024 * 1024
private const val MIN_CONCURRENCY = 1
private const val MAX_CONCURRENCY = 8
private const val MIN_RETRIES = 0
private const val MAX_RETRIES = 8
private const val MIN_PAGE_SIZE = 1
private const val MAX_PAGE_SIZE = 500
private const val MIN_OVERLAP_MINUTES = 0L
private const val MAX_OVERLAP_MINUTES = 1_440L
private const val MIN_CENSUS_HOURS = 1
private const val MAX_CENSUS_HOURS = 168
private const val MILLIS_PER_SECOND = 1_000L
private const val HTTPS_PORT = 443
private const val HTTP_PORT = 80
