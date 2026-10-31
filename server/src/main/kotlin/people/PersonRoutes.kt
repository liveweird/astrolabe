package ch.nokillswit.people

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireAdmin
import ch.nokillswit.infra.db.orVanished
import ch.nokillswit.infra.paging.optionalString
import ch.nokillswit.infra.paging.parsePaging
import ch.nokillswit.infra.paging.toPage
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
@Resource("/api/v1/people")
class PeopleRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: PeopleRoute = PeopleRoute(), val id: UInt)
}

fun Application.configurePersonRoutes() {
    val personService = attributes[PersonServiceKey]

    routing {
        authenticate {
            // Reads are any-authenticated (the owner and manager pickers, the People page); every mutation is
            // ADMIN-only with the guard BEFORE the body decodes and the id lookup — a non-admin probe gets a
            // uniform 403 whether or not the id exists.
            get<PeopleRoute> {
                call.caller()
                val paging = call.parsePaging(sortable = PERSON_SORT_FIELDS)
                val params = call.request.queryParameters
                val filter = PersonListFilter(
                    name = params.optionalString("name"),
                    email = params.optionalString("email"),
                )
                val result = personService.list(filter, paging)
                call.respond(HttpStatusCode.OK, paging.toPage(result.items, result.total))
            }
            post<PeopleRoute> {
                val caller = call.caller()
                requireAdmin(caller)
                val request = sanitizedPersonCreate(call.receive())
                validatePersonCreate(request)
                val id = personService.create(request)
                audit(
                    "person.created",
                    "byUserId" to caller.userId.toLong(),
                    "personId" to id.toLong(),
                    "name" to request.name,
                    "userId" to request.userId?.toLong(),
                )
                call.response.header(HttpHeaders.Location, call.application.href(PeopleRoute.Id(id = id)))
                call.respond(HttpStatusCode.Created, personService.read(id).orVanished("Person", id))
            }
            get<PeopleRoute.Id> { route ->
                call.caller()
                call.respond(HttpStatusCode.OK, personService.read(route.id).orNotFound("Person"))
            }
            put<PeopleRoute.Id> { route ->
                val caller = call.caller()
                requireAdmin(caller)
                val request = sanitizedPersonUpdate(call.receive())
                validatePersonUpdate(request)
                val outcome = personService.update(route.id, request)
                outcome.affected.orNotFound("Person")
                audit(
                    "person.updated",
                    "byUserId" to caller.userId.toLong(),
                    "personId" to route.id.toLong(),
                    "name" to request.name,
                )
                // A login link is a rights path (the person's owner rights ride it), so it is its own trail line.
                if (outcome.userFrom != request.userId) {
                    audit(
                        "person.link_changed",
                        "byUserId" to caller.userId.toLong(),
                        "personId" to route.id.toLong(),
                        "userFrom" to outcome.userFrom?.toLong(),
                        "userTo" to request.userId?.toLong(),
                    )
                }
                call.respond(HttpStatusCode.NoContent)
            }
            delete<PeopleRoute.Id> { route ->
                val caller = call.caller()
                requireAdmin(caller)
                personService.delete(route.id).orNotFound("Person")
                audit("person.deleted", "byUserId" to caller.userId.toLong(), "personId" to route.id.toLong())
                call.respond(HttpStatusCode.NoContent)
            }
        }
    }
}
