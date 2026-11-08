package ch.nokillswit.flow

import ch.nokillswit.infra.config.requireConfigInt
import ch.nokillswit.infra.config.requireConfigLong
import ch.nokillswit.infra.fetch.OutboundPermits
import ch.nokillswit.infra.outbound.FlowOrigins
import ch.nokillswit.infra.outbound.TlsTrust
import ch.nokillswit.infra.outbound.guardedKtorClient
import ch.nokillswit.infra.outbound.guardedOkHttpClient
import ch.nokillswit.infra.outbound.loadCaBundleTrust
import ch.nokillswit.infra.outbound.parseFlowInsecureOrigins
import ch.nokillswit.infra.outbound.parseSelfManagedHosts
import io.ktor.client.HttpClient
import io.ktor.server.application.*
import io.ktor.util.AttributeKey
import okhttp3.EventListener
import org.slf4j.LoggerFactory
import java.net.InetAddress

private val log = LoggerFactory.getLogger("ch.nokillswit.flow")

val FlowConnectorKey = AttributeKey<FlowConnector>("FlowConnector")

/** The operator's origin rule: published so the registry's `baseUrl` check (composition root) and the tests read what the client uses. */
val FlowOriginsKey = AttributeKey<FlowOrigins>("FlowOrigins")

/** The shared guarded client - published so a test can assert it is closed on [ApplicationStopped] and drive it through the guard. */
val FlowHttpClientKey = AttributeKey<HttpClient>("FlowHttpClient")

/**
 * Wires the Flow HTTP stack (`.claude/docs/security.md` "The Flow consumer"): ONE guarded `HttpClient(OkHttp)` shared by every connection,
 * its allow-list the operator's [FlowOrigins] (`flow.allowedHosts`, `flow.allowedCidrs`, `flow.caBundle`, and in development mode ONLY
 * `flow.insecureOrigins`). A non-blank `flow.insecureOrigins` outside development mode refuses startup (fail-closed, the shape of
 * `jira.stubBaseUrl` in `jira/Jira.kt`), naming the key and never the value. Registered in `application.yaml` after the Jira wiring,
 * before the sync registry (the run, a later step, registers its connector there).
 *
 * Flow's in-flight budget is NOT sized by a second heap-fit check: the bounds are tight enough that no configuration can exceed the 96 MiB
 * reserve `jira/JiraHeapFit.kt` keeps for what is not Jira's. At most `flow.maxConcurrentRequests` (1..2) bodies of at most
 * `flow.maxResponseBytes` (64 KiB..1 MiB, the transport's big-parse threshold, so no Flow body takes the big-parse lock) are parsed at
 * once, each tree at most 112 B x (1 MiB / 8 B) = 14 MiB: worst case 2 x (1 MiB + 14 MiB) = 30 MiB (`security.md` "The Flow consumer").
 */
fun Application.configureFlow() {
    val config = environment.config
    fun text(key: String): String = config.propertyOrNull(key)?.getString()?.trim().orEmpty()
    if (!developmentMode && text("flow.insecureOrigins").isNotEmpty()) {
        error("Config \"flow.insecureOrigins\" must be blank outside development mode (production never reaches a plain-http Flow)")
    }
    val requestTimeoutSeconds = requireConfigLong(config, "flow.requestTimeoutSeconds", MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)
    val requestDeadlineSeconds = requireConfigLong(config, "flow.requestDeadlineSeconds", MIN_DEADLINE_SECONDS, MAX_DEADLINE_SECONDS)
    val maxResponseBytes = requireConfigLong(config, "flow.maxResponseBytes", MIN_RESPONSE_BYTES, MAX_RESPONSE_BYTES)
    val maxConcurrentRequests = requireConfigInt(config, "flow.maxConcurrentRequests", MIN_CONCURRENCY, MAX_CONCURRENCY)
    val maxRetries = requireConfigInt(config, "flow.maxRetries", MIN_RETRIES, MAX_RETRIES)
    val sprintsSinceDays = requireConfigInt(config, "flow.sprintsSinceDays", MIN_SPRINTS_SINCE_DAYS, MAX_SPRINTS_SINCE_DAYS)
    val hosts = parseSelfManagedHosts(text("flow.allowedHosts"), text("flow.allowedCidrs"), "flow.allowedHosts", "flow.allowedCidrs")
    val insecure = parseFlowInsecureOrigins(text("flow.insecureOrigins"), "flow.insecureOrigins")
    val tls = text("flow.caBundle").takeIf { it.isNotEmpty() }?.let { loadCaBundleTrust(it, "flow.caBundle") }
    val origins = FlowOrigins(hosts, insecure, developmentMode)
    attributes.put(FlowOriginsKey, origins)

    val httpClient = buildGuardedFlowHttpClient(origins, tls, requestTimeoutSeconds = requestTimeoutSeconds)
    // ONE long-lived client for the app's whole life: closing it on ApplicationStopped releases the OkHttp dispatcher/connection-pool
    // threads (a stopped Application otherwise leaks them - the test suite starts and stops hundreds).
    attributes.put(FlowHttpClientKey, httpClient)
    monitor.subscribe(ApplicationStopped) { httpClient.close() }
    // Flow's own permit pool (not Jira's): a slow Flow can never hold a Jira call behind it, nor the reverse.
    val flowHttp = createFlowHttp(
        httpClient, maxRetries, maxResponseBytes, maxConcurrentRequests,
        requestDeadlineMillis = requestDeadlineSeconds * MILLIS_PER_SECOND, permits = OutboundPermits(maxConcurrentRequests),
    )
    attributes.put(FlowConnectorKey, FlowConnector({ baseUrl, token -> HttpFlowClient(flowHttp, baseUrl, token) }, sprintsSinceDays))
    // Counts only: never a host, an origin or a path.
    log.info(
        "Flow outbound wired ({} allowed host(s), {} development origin(s), {})",
        hosts.origins().size, insecure.size, if (tls != null) "extra CA bundle" else "default trust",
    )
}

/**
 * Builds EXACTLY the guarded Ktor `HttpClient(OkHttp)` [configureFlow] wires into production - factored out so a test can build the SAME
 * client (not a hand-rolled approximation that could silently drift if the guard were ever unwired) and drive it against the loopback
 * Flow stub. [tls] is the operator's extra CA bundle (alongside the JVM defaults); there is no way to skip verification.
 */
fun buildGuardedFlowHttpClient(
    origins: FlowOrigins,
    tls: TlsTrust? = null,
    resolver: (String) -> List<InetAddress> = { InetAddress.getAllByName(it).toList() },
    eventListener: EventListener = EventListener.NONE,
    requestTimeoutSeconds: Long,
): HttpClient {
    val okHttpClient = guardedOkHttpClient(
        allowedHost = origins::hostAllowed,
        resolver = resolver,
        timeoutSeconds = requestTimeoutSeconds,
        addressAllowed = origins::addressAllowed,
        schemeFor = origins::schemeFor,
        eventListener = eventListener,
        sslSocketFactory = tls?.sslSocketFactory,
        trustManager = tls?.trustManager,
        originAllowed = origins::originAllowed,
    )
    return guardedKtorClient(okHttpClient, requestTimeoutSeconds)
}

private const val MIN_TIMEOUT_SECONDS = 5L
private const val MAX_TIMEOUT_SECONDS = 120L
private const val MIN_DEADLINE_SECONDS = 10L
private const val MAX_DEADLINE_SECONDS = 600L
private const val MIN_RESPONSE_BYTES = 65_536L
private const val MAX_RESPONSE_BYTES = 1024L * 1024
private const val MIN_CONCURRENCY = 1
private const val MAX_CONCURRENCY = 2
private const val MIN_RETRIES = 0
private const val MAX_RETRIES = 8
private const val MIN_SPRINTS_SINCE_DAYS = 30
private const val MAX_SPRINTS_SINCE_DAYS = 1_095
private const val MILLIS_PER_SECOND = 1_000L
