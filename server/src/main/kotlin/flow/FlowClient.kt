package ch.nokillswit.flow

import ch.nokillswit.infra.fetch.SourceHttp
import io.ktor.http.HttpMethod
import java.time.LocalDate

/**
 * The slice of Flow's read-only service-token API the sync needs (Flow 1.57.0; nothing here writes to Flow). Each method throws a
 * `FetchException` carrying the transport's code: `AUTHENTICATION_FAILED` (401: the token is revoked, expired or wrong - Flow's one
 * uniform answer), `NOT_FOUND` (404: a Flow older than 1.57.0), `UPSTREAM_UNAVAILABLE` (5xx: an outage, retried with backoff),
 * `RATE_LIMITED` (429), `REDIRECT` (3xx: never followed), `LIMIT_EXCEEDED` (the response cap), `INVALID_RESPONSE` (a body that is not the
 * contract), `TIMEOUT` (the call's deadline, or no outbound permit in time) or `BLOCKED_HOST` (the origin guard).
 */
interface FlowClient {
    /** `GET /api/v1/integration/me`. */
    suspend fun me(): FlowMe

    /** `GET /api/v1/integration/teams?sprintsSince=`: one document, every team with its members and sprints. */
    suspend fun teams(sprintsSince: LocalDate): FlowTeamsDocument
}

/** Builds a client for one connection's origin and (decrypted) service token. */
fun interface FlowClientFactory {
    fun create(baseUrl: String, apiToken: String): FlowClient
}

/**
 * [baseUrl] is a connection's stored origin (validated against the operator's list at write time and judged again, per request, by the
 * guarded client); the API paths are appended to it. [apiToken] only builds the `Authorization` header and is kept nowhere else.
 */
class HttpFlowClient(
    private val http: SourceHttp,
    private val baseUrl: String,
    apiToken: String,
) : FlowClient {
    private val auth = flowAuthHeader(apiToken)

    // The decode runs INSIDE the transport's transform (`requestAs`): the parsed tree is garbage before the next big body is parsed.
    override suspend fun me(): FlowMe = http.requestAs(HttpMethod.Get, "$baseUrl$FLOW_ME_PATH", authHeader = auth, pauseKey = baseUrl) {
        decodeFlowMe(it)
    }

    override suspend fun teams(sprintsSince: LocalDate): FlowTeamsDocument = http.requestAs(
        HttpMethod.Get, "$baseUrl$FLOW_TEAMS_PATH", mapOf(FLOW_SPRINTS_SINCE_PARAMETER to sprintsSince.toString()),
        authHeader = auth, pauseKey = baseUrl,
    ) { decodeFlowTeams(it) }
}

/**
 * What `configureFlow` publishes (`FlowConnectorKey`): the client factory over the guarded transport and the one setting the run reads.
 * The Test connection and the run (`FlowObserver`) take their clients from here, so neither names the transport.
 */
class FlowConnector(
    private val clients: FlowClientFactory,
    /** `flow.sprintsSinceDays`: a run asks for sprints that ended no earlier than this many days ago. */
    val sprintsSinceDays: Int,
) {
    fun client(baseUrl: String, apiToken: String): FlowClient = clients.create(baseUrl, apiToken)
}
