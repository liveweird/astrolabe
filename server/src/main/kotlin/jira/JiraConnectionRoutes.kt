package ch.nokillswit.jira

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireAdmin
import ch.nokillswit.infra.db.orVanished
import ch.nokillswit.infra.paging.parsePaging
import ch.nokillswit.infra.paging.toPage
import ch.nokillswit.people.PersonServiceKey
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
@Resource("/api/v1/integrations/jira/connections")
class JiraConnectionsRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: JiraConnectionsRoute = JiraConnectionsRoute(), val id: UInt)
}

/**
 * The Jira sync's routes, ONE module function for the whole `jira/` package (`conventions.md`: one routes file per concern - connections
 * here; mapping and Peek register from here, bindings and deviations as they land). The registry is ADMIN only, reads included (a
 * connection names a credential-bearing site): `requireAdmin` runs FIRST on every route, before the id lookup and before the body
 * decodes, so a non-admin gets a uniform 403 whether or not the id exists and whatever the body is (guard-before-read, the `teams/`
 * rule).
 */
fun Application.configureJiraRoutes() {
    val connections = attributes[JiraConnectionServiceKey]
    val connector = attributes[JiraConnectorKey]
    val bindings = attributes[JiraBindingServiceKey]
    val people = attributes[PersonServiceKey]

    routing {
        authenticate {
            jiraTestRoutes(connections, connector)
            jiraMappingRoutes(connections, connector)
            jiraBindingRoutes(connections, bindings, people, connector)
            get<JiraConnectionsRoute> {
                requireAdmin(call.caller())
                val paging = call.parsePaging(sortable = JIRA_CONNECTION_SORT_FIELDS)
                val result = connections.list(paging)
                call.respond(HttpStatusCode.OK, paging.toPage(result.items, result.total))
            }
            post<JiraConnectionsRoute> {
                val caller = call.caller()
                requireAdmin(caller)
                val request = sanitizedJiraConnection(call.receive())
                validateJiraConnection(request, apiTokenRequired = true)
                val id = connections.create(request)
                // Name and host only: the token (and the account email) never reach the trail.
                audit(
                    "jira.connection_created",
                    "byUserId" to caller.userId.toLong(),
                    "connectionId" to id.toLong(),
                    "name" to request.name,
                    "host" to jiraHostOf(request.siteUrl),
                )
                call.response.header(HttpHeaders.Location, call.application.href(JiraConnectionsRoute.Id(id = id)))
                call.respond(HttpStatusCode.Created, connections.read(id).orVanished("Jira connection", id))
            }
            get<JiraConnectionsRoute.Id> { route ->
                requireAdmin(call.caller())
                call.respond(HttpStatusCode.OK, connections.read(route.id).orNotFound("Jira connection"))
            }
            put<JiraConnectionsRoute.Id> { route ->
                val caller = call.caller()
                requireAdmin(caller)
                val request = sanitizedJiraConnection(call.receive())
                validateJiraConnection(request, apiTokenRequired = false)
                val outcome = connections.update(route.id, request)
                outcome.affected.orNotFound("Jira connection")
                audit(
                    "jira.connection_updated",
                    "byUserId" to caller.userId.toLong(),
                    "connectionId" to route.id.toLong(),
                    "name" to request.name,
                    "host" to outcome.host,
                    "tokenRotated" to outcome.tokenRotated,
                )
                call.respond(HttpStatusCode.NoContent)
            }
            delete<JiraConnectionsRoute.Id> { route ->
                val caller = call.caller()
                requireAdmin(caller)
                val outcome = connections.delete(route.id)
                outcome.affected.orNotFound("Jira connection")
                audit(
                    "jira.connection_deleted",
                    "byUserId" to caller.userId.toLong(),
                    "connectionId" to route.id.toLong(),
                    "name" to outcome.name,
                    "host" to outcome.host,
                    "bindingsUnbound" to outcome.bindingsUnbound,
                )
                call.respond(HttpStatusCode.NoContent)
            }
        }
    }
}
