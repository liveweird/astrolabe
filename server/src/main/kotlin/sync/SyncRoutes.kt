package ch.nokillswit.sync

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.requireAdmin
import ch.nokillswit.infra.paging.optionalEnum
import ch.nokillswit.infra.paging.optionalUInt
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.request.receive
import io.ktor.server.resources.get
import io.ktor.server.resources.post
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/integrations/sync/runs")
class SyncRunsRoute

/**
 * The run registry's routes. **POST** (ADMIN, `requireAdmin` before the body decodes, the registry's guard-before-read rule): the
 * connector confirms the connection can run (a `400` on the body field otherwise), the claim INSERTs the unfinished row (`409`
 * `urn:astrolabe:problem:run-in-progress` when one exists), the request is audited, the run starts in the background and the answer is
 * `202` with the unfinished row. **GET** (any authenticated user - a run names no secret and the Deviations page shows the last one):
 * the newest runs first, at most 50, filtered by the optional `kind` and `connectionId`.
 */
internal fun Route.syncRoutes(runs: SyncRunService, runner: SyncRunner, connectors: SyncConnectors) {
    get<SyncRunsRoute> {
        call.caller()
        val query = call.request.queryParameters
        call.respond(HttpStatusCode.OK, SyncRunList(runs.list(query.optionalEnum<SyncKind>("kind"), query.optionalUInt("connectionId"))))
    }
    post<SyncRunsRoute> {
        val caller = call.caller()
        requireAdmin(caller)
        val request = call.receive<SyncRunRequest>()
        val connector = connectors.of(request.kind) ?: throw BadRequestException("No ${request.kind} connector is configured")
        connector.requireRunnable(request.connectionId)
        val claimed = runs.claim(connector, request.connectionId, SyncTrigger.MANUAL, caller.userId)
        audit(
            "${request.kind.name.lowercase()}.sync_requested",
            "byUserId" to caller.userId.toLong(),
            "connectionId" to request.connectionId.toLong(),
            "runId" to claimed.id.toLong(),
        )
        runner.start(connector, claimed)
        call.respond(HttpStatusCode.Accepted, claimed.toResponse())
    }
}
