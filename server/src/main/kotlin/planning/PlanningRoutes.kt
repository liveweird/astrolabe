package ch.nokillswit.planning

import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.authz.isAdmin
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.authz.requireAncestorOwnerOrAdmin
import ch.nokillswit.authz.requireOwnerOrAdmin
import ch.nokillswit.authz.requireTargetWindowEditorOrAdmin
import ch.nokillswit.authz.requireTeamManagerOrAdmin
import ch.nokillswit.people.PersonService
import ch.nokillswit.people.PersonServiceKey
import ch.nokillswit.teams.TeamService
import ch.nokillswit.teams.TeamServiceKey
import ch.nokillswit.users.Permission
import ch.nokillswit.users.UserService
import ch.nokillswit.users.UserServiceKey
import io.ktor.server.application.*
import io.ktor.server.auth.authenticate
import io.ktor.server.routing.routing

/**
 * The planning REST surface (`/api/v1/work-streams`, `/programs`, `/projects`, `/milestones`, `/views/plan`, `/views/project/{id}`,
 * `/views/roadmap`, `/roadmap/ranking`, and since V15 `/dependencies` with `POST /projects/{id}/dependencies`), registered by this ONE
 * module function and split per entity (`WorkStreamRoutes.kt`, `ProgramRoutes.kt`, `ProjectRoutes.kt`, `MilestoneRoutes.kt`,
 * `DependencyRoutes.kt`, `PlanViewRoutes.kt`, `RoadmapRoutes.kt`) — the first deliberate exception to the one-routes-file template
 * (`conventions.md`): five resources with different guards would blow the
 * 400-line file cap. Every node route is READ-BEFORE-GUARD (chain -> 404, guard -> 403, body -> 400, validate -> 400, write;
 * `authorization.md`): plan ids are sequential and every signed-in user reads the whole plan anyway, so existence is no secret.
 * The guard before the body is for ORDERING only: a request can be held open after it (a slow body), so the write RE-GUARDS under
 * the plan lock ([PlanRouteDeps.ownerGuard]/[PlanRouteDeps.windowGuard]) against a re-read chain, person link and grant. The ranking
 * PUT is the exception to read-before-guard: it addresses no node, so it is guard-before-read (`RoadmapRoutes.kt`).
 */
fun Application.configurePlanningRoutes() {
    val deps = PlanRouteDeps(
        people = attributes[PersonServiceKey],
        users = attributes[UserServiceKey],
        workStreams = attributes[WorkStreamServiceKey],
        programs = attributes[ProgramServiceKey],
        projects = attributes[ProjectServiceKey],
        milestones = attributes[MilestoneServiceKey],
        dependencies = attributes[DependencyServiceKey],
        teams = attributes[TeamServiceKey],
        view = attributes[PlanViewServiceKey],
        projectView = attributes[ProjectViewServiceKey],
        roadmap = attributes[RoadmapServiceKey],
    )
    routing {
        authenticate {
            workStreamRoutes(deps)
            programRoutes(deps)
            projectRoutes(deps)
            milestoneRoutes(deps)
            dependencyRoutes(deps)
            planViewRoutes(deps)
            roadmapRoutes(deps)
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
    val milestones: MilestoneService,
    val dependencies: DependencyService,
    val teams: TeamService,
    val view: PlanViewService,
    val projectView: ProjectViewService,
    val roadmap: RoadmapService,
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
     * The SOURCE half of a move, read-before-guard: a missing [chain] is the 404 for [resource], then the caller must be ADMIN or own
     * something ABOVE the node ([requireAncestorOwnerOrAdmin]) — the node's own owner is not enough. Returns the caller's person (null
     * for an ADMIN or a person-less login) for [requireMoveTarget], so it is resolved once.
     */
    suspend fun requireMoveSource(caller: CallerPrincipal, chain: OwnerChain?, resource: String): UInt? {
        val resolved = chain.orNotFound(resource)
        val person = callerPersonId(caller)
        requireAncestorOwnerOrAdmin(caller, person, resolved)
        return person
    }

    /**
     * The TARGET half of a move, after [requireMoveSource] and the body: a missing [chain] is a 400 on the body field
     * ("Unknown or deleted [kind] ids: [id]"), then the caller ([person], as [requireMoveSource] resolved it) must own the target chain
     * too (or be ADMIN) — the same rule as creating a child there.
     */
    fun requireMoveTarget(caller: CallerPrincipal, person: UInt?, chain: OwnerChain?, kind: String, id: UInt) {
        requireOwnerOrAdmin(caller, person, chain ?: unknownMoveTarget(kind, id))
    }

    /** The two guards a move re-runs inside the plan lock ([MoveGuards]), sharing one `FOR SHARE` lookup of the caller's person. */
    fun moveGuards(caller: CallerPrincipal): MoveGuards {
        var resolved = false
        var person: UInt? = null
        val lockedPerson: suspend () -> UInt? = {
            if (!resolved) {
                person = lockedCallerPersonId(caller)
                resolved = true
            }
            person
        }
        return MoveGuards(
            source = { chain -> requireAncestorOwnerOrAdmin(caller, lockedPerson(), chain) },
            target = { chain -> requireOwnerOrAdmin(caller, lockedPerson(), chain) },
        )
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

    /**
     * The read-before-guard preamble of the schedule write: a missing [chain] is the 404, then the caller must be ADMIN or the ACTIVE
     * manager of the milestone's STORED team (`requireTeamManagerOrAdmin`, asked of the database per request). The project's owner is
     * deliberately NOT enough. Returns the resolved chain.
     */
    suspend fun requireManager(caller: CallerPrincipal, chain: MilestoneChain?): MilestoneChain {
        val resolved = chain.orNotFound("Milestone")
        requireTeamManagerOrAdmin(caller, resolved.teamId, teams::isActiveManager)
        return resolved
    }

    /**
     * The guard the schedule write re-runs INSIDE the plan lock (see [ScheduleGuard]): the same `requireTeamManagerOrAdmin`, against the
     * team of the chain re-read there, with the manager lookup locking the team and the manager's person `FOR SHARE`
     * ([TeamService.lockedIsActiveManager]). ADMIN short-circuits without a lookup.
     */
    fun managerGuard(caller: CallerPrincipal): ScheduleGuard = { chain ->
        requireTeamManagerOrAdmin(caller, chain.teamId, teams::lockedIsActiveManager)
    }

    private suspend fun lockedCallerPersonId(caller: CallerPrincipal): UInt? =
        if (caller.isAdmin()) null else people.lockedActivePersonIdOf(caller.userId)

    /**
     * The views' actor: the ADMIN flag, the caller's person and (for a non-admin) the roadmap-editor grant, each resolved once per
     * request. The teams the caller manages are looked up only when [withManagedTeams] (the project view's `can.schedule` flags);
     * the other views never read them, so they stay an empty set there.
     */
    suspend fun actor(caller: CallerPrincipal, withManagedTeams: Boolean = false): PlanActor {
        val admin = caller.isAdmin()
        return PlanActor(
            isAdmin = admin,
            personId = callerPersonId(caller),
            roadmapEditor = !admin && hasPermission(caller.userId, Permission.ROADMAP_EDITOR),
            managedTeamIds = if (admin || !withManagedTeams) emptySet() else teams.activeManagedTeamIds(caller.userId),
        )
    }
}
