package ch.nokillswit.planning

import ch.nokillswit.audit.audit
import ch.nokillswit.authz.caller
import ch.nokillswit.authz.orNotFound
import io.ktor.http.HttpStatusCode
import io.ktor.resources.Resource
import io.ktor.server.application.*
import io.ktor.server.resources.delete
import io.ktor.server.resources.get
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

@Serializable
@Resource("/api/v1/dependencies")
class DependenciesRoute {
    @Serializable
    @Resource("{id}")
    class Id(val parent: DependenciesRoute = DependenciesRoute(), val id: UInt)
}

private const val DEPENDENCY = "Dependency"

/**
 * Dependencies (V15): created under the SUCCESSOR's project (`POST /projects/{id}/dependencies`, in `ProjectRoutes.kt` — the parent id
 * in the path is what the guard needs). Read is any authenticated user. A delete needs an owner on the SUCCESSOR's project chain — the
 * project's own owner included — or ADMIN, read-before-guard (404, then 403); the predecessor's owner may not delete a link another
 * project depends on, and a team manager as such has no say (links never move dates). The write re-runs the guard under the plan lock
 * against the chain re-read there.
 */
internal fun Route.dependencyRoutes(d: PlanRouteDeps) {
    get<DependenciesRoute.Id> { route ->
        call.caller()
        call.respond(HttpStatusCode.OK, d.dependencies.read(route.id).orNotFound(DEPENDENCY))
    }
    delete<DependenciesRoute.Id> { route ->
        val caller = call.caller()
        d.requireOwner(caller, d.dependencies.chain(route.id)?.owners, DEPENDENCY)
        val deleted = d.dependencies.delete(route.id, d.ownerGuard(caller))
        audit(
            "dependency.deleted",
            "byUserId" to caller.userId.toLong(),
            "dependencyId" to route.id.toLong(),
            "predKind" to deleted.predecessor.kind.name,
            "predId" to deleted.predecessor.id.toLong(),
            "succKind" to deleted.successor.kind.name,
            "succId" to deleted.successor.id.toLong(),
        )
        call.respond(HttpStatusCode.NoContent)
    }
}
