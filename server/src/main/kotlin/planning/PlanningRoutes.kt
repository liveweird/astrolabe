package ch.nokillswit.planning

import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.authz.isAdmin
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireOwnerOrAdmin
import ch.nokillswit.authz.requireTargetWindowEditorOrAdmin
import ch.nokillswit.people.PersonService
import ch.nokillswit.people.PersonServiceKey
import ch.nokillswit.users.Permission
import ch.nokillswit.users.UserService
import ch.nokillswit.users.UserServiceKey
import io.ktor.server.application.*
import io.ktor.server.auth.authenticate
import io.ktor.server.routing.routing

/**
 * The planning REST surface (`/api/v1/work-streams`, `/programs`, `/projects`, `/views/plan`), registered by this ONE module
 * function and split per entity (`WorkStreamRoutes.kt`, `ProgramRoutes.kt`, `ProjectRoutes.kt`, `PlanViewRoutes.kt`) — the first
 * deliberate exception to the one-routes-file template (`conventions.md`): four resources with different guards would blow the
 * 400-line file cap. Every node route is READ-BEFORE-GUARD (chain -> 404, guard -> 403, body -> 400, validate -> 400, write;
 * `authorization.md`): plan ids are sequential and every signed-in user reads the whole plan anyway, so existence is no secret.
 * The guard before the body is for ORDERING only: a request can be held open after it (a slow body), so the write RE-GUARDS under
 * the plan lock ([PlanRouteDeps.ownerGuard]/[PlanRouteDeps.windowGuard]) against a re-read chain, person link and grant.
 */
fun Application.configurePlanningRoutes() {
    val deps = PlanRouteDeps(
        people = attributes[PersonServiceKey],
        users = attributes[UserServiceKey],
        workStreams = attributes[WorkStreamServiceKey],
        programs = attributes[ProgramServiceKey],
        projects = attributes[ProjectServiceKey],
        view = attributes[PlanViewServiceKey],
    )
    routing {
        authenticate {
            workStreamRoutes(deps)
            programRoutes(deps)
            projectRoutes(deps)
            planViewRoutes(deps)
        }
    }
}

/** The services the planning routes share, plus the per-request caller resolution the guards and the `can` flags need. */
internal class PlanRouteDeps(
    val people: PersonService,
    val users: UserService,
    val workStreams: WorkStreamService,
    val programs: ProgramService,
    val projects: ProjectService,
    val view: PlanViewService,
) {
    /** `UserService.hasPermission` as the guards' injected lookup (a database read per request, never a token claim). */
    val hasPermission: suspend (userId: UInt, permission: Permission) -> Boolean = users::hasPermission

    /** The caller's ACTIVE person, or null — not looked up for an ADMIN, who needs no ownership. */
    suspend fun callerPersonId(caller: CallerPrincipal): UInt? =
        if (caller.isAdmin()) null else people.activePersonIdOf(caller.userId)

    /**
     * The read-before-guard preamble of a node route: a missing [chain] is the 404 for [resource], then the caller must own the
     * node or anything above it (or be ADMIN) — a 403 otherwise.
     */
    suspend fun requireOwner(caller: CallerPrincipal, chain: OwnerChain?, resource: String) {
        val resolved = chain.orNotFound(resource)
        requireOwnerOrAdmin(caller, callerPersonId(caller), resolved)
    }

    /**
     * The guard the services re-run INSIDE the plan lock (see [PlanGuard]): the same `requireOwnerOrAdmin`, against the chain re-read
     * there and the caller's person re-resolved `FOR SHARE` in the same transaction. ADMIN short-circuits without a lookup.
     */
    fun ownerGuard(caller: CallerPrincipal): PlanGuard = { chain ->
        requireOwnerOrAdmin(caller, lockedCallerPersonId(caller), chain)
    }

    /** [ownerGuard] for the target window: also re-reads the `ROADMAP_EDITOR` grant in the same transaction. */
    fun windowGuard(caller: CallerPrincipal): PlanGuard = { chain ->
        requireTargetWindowEditorOrAdmin(caller, lockedCallerPersonId(caller), chain, hasPermission)
    }

    private suspend fun lockedCallerPersonId(caller: CallerPrincipal): UInt? =
        if (caller.isAdmin()) null else people.lockedActivePersonIdOf(caller.userId)

    /** The plan view's actor: the ADMIN flag, the caller's person and (for a non-admin) the roadmap-editor grant. */
    suspend fun actor(caller: CallerPrincipal): PlanActor {
        val admin = caller.isAdmin()
        return PlanActor(
            isAdmin = admin,
            personId = callerPersonId(caller),
            roadmapEditor = !admin && hasPermission(caller.userId, Permission.ROADMAP_EDITOR),
        )
    }
}
