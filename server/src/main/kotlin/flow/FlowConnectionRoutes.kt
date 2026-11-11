package ch.nokillswit.flow

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireAdmin
import ch.nokillswit.infra.db.orVanished
import ch.nokillswit.infra.outbound.FlowBaseUrlVerdict
import ch.nokillswit.infra.paging.parsePaging
import ch.nokillswit.infra.paging.toPage
import ch.nokillswit.teams.CapacityWriteListenersKey
import ch.nokillswit.teams.TeamServiceKey
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.resources.delete
import io.ktor.server.resources.get
import io.ktor.server.resources.href
import io.ktor.server.resources.post
import io.ktor.server.resources.put
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.routing.routing
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/integrations/flow/connections")
class FlowConnectionsRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: FlowConnectionsRoute = FlowConnectionsRoute(), val id: UInt)
}

/** `GET /api/v1/integrations/flow/origins`: the operator's list a connection's base URL must be one of (ADMIN only, a read: no audit). */
@Serializable
@Resource("/api/v1/integrations/flow/origins")
class FlowOriginsRoute

/**
 * The Flow sync's routes, ONE module function for the whole `flow/` package (`conventions.md`: one routes file per concern - the
 * connections here, Test connection beside it). The registry is ADMIN only, reads included (a connection names a credential-bearing
 * Flow): `requireAdmin` runs FIRST on every route, before the id lookup and before the body decodes, so a non-admin gets a uniform 403
 * whether or not the id exists and whatever the body is (guard-before-read, the `teams/` rule). Nothing here writes to Flow.
 */
fun Application.configureFlowRoutes() {
    val connections = attributes[FlowConnectionServiceKey]
    val connector = attributes[FlowConnectorKey]
    val origins = attributes[FlowOriginsKey]
    val bindings = attributes[FlowTeamBindingServiceKey]
    val flowTeams = attributes[FlowTeamServiceKey]
    val capacityImport = attributes[CapacityImportServiceKey]
    val capacityDeviations = attributes[CapacityDeviationServiceKey]
    val capacityAcknowledgements = attributes[CapacityAcknowledgeServiceKey]
    val teams = attributes[TeamServiceKey]
    val capacityListeners = attributes[CapacityWriteListenersKey]

    routing {
        authenticate {
            flowTestRoutes(connections, connector, origins)
            flowTeamBindingRoutes(bindings, flowTeams, teams)
            capacityImportRoutes(capacityImport, bindings, teams, capacityListeners)
            capacityAcknowledgeRoutes(capacityAcknowledgements, bindings, teams)
            capacityDeviationRoutes(capacityDeviations, teams)
            get<FlowOriginsRoute> {
                requireAdmin(call.caller())
                call.respond(HttpStatusCode.OK, FlowOriginList(origins.allowedOrigins()))
            }
            get<FlowConnectionsRoute> {
                requireAdmin(call.caller())
                val paging = call.parsePaging(sortable = FLOW_CONNECTION_SORT_FIELDS)
                val result = connections.list(paging)
                call.respond(HttpStatusCode.OK, paging.toPage(result.items, result.total))
            }
            post<FlowConnectionsRoute> {
                val caller = call.caller()
                requireAdmin(caller)
                val request = sanitizedFlowConnection(call.receive())
                validateFlowConnection(request, apiTokenRequired = true, origins::baseUrlVerdict)
                val id = connections.create(request)
                // Name and host only: the token never reaches the trail.
                audit(
                    "flow.connection_created",
                    "byUserId" to caller.userId.toLong(),
                    "connectionId" to id.toLong(),
                    "name" to request.name,
                    "host" to flowHostOf(request.baseUrl),
                    "pollIntervalMinutes" to request.pollIntervalMinutes,
                )
                call.response.header(HttpHeaders.Location, call.application.href(FlowConnectionsRoute.Id(id = id)))
                call.respond(HttpStatusCode.Created, connections.read(id).orVanished("Flow connection", id))
            }
            get<FlowConnectionsRoute.Id> { route ->
                requireAdmin(call.caller())
                call.respond(HttpStatusCode.OK, connections.read(route.id).orNotFound("Flow connection"))
            }
            put<FlowConnectionsRoute.Id> { route ->
                val caller = call.caller()
                requireAdmin(caller)
                val request = sanitizedFlowConnection(call.receive())
                // The origin is the connection's identity and cannot change (a different one is the service's 409), so an unchanged origin
                // the operator has since delisted must not stop an admin from disabling or re-tokening the connection: not asked here.
                validateFlowConnection(request, apiTokenRequired = false) { FlowBaseUrlVerdict.ALLOWED }
                val outcome = connections.update(route.id, request)
                outcome.affected.orNotFound("Flow connection")
                audit(
                    "flow.connection_updated",
                    "byUserId" to caller.userId.toLong(),
                    "connectionId" to route.id.toLong(),
                    "name" to request.name,
                    "host" to outcome.host,
                    "tokenRotated" to outcome.tokenRotated,
                    "pollIntervalMinutes" to request.pollIntervalMinutes,
                )
                call.respond(HttpStatusCode.NoContent)
            }
            delete<FlowConnectionsRoute.Id> { route ->
                val caller = call.caller()
                requireAdmin(caller)
                val outcome = connections.delete(route.id)
                outcome.affected.orNotFound("Flow connection")
                audit(
                    "flow.connection_deleted",
                    "byUserId" to caller.userId.toLong(),
                    "connectionId" to route.id.toLong(),
                    "name" to outcome.name,
                    "host" to outcome.host,
                    "bindingsUnbound" to outcome.bindingsUnbound,
                    "runsDeleted" to outcome.runsDeleted,
                    "acknowledgementsDeleted" to outcome.acknowledgementsDeleted,
                )
                call.respond(HttpStatusCode.NoContent)
            }
        }
    }
}
