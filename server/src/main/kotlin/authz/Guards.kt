package ch.nokillswit.authz

import ch.nokillswit.users.Feature
import ch.nokillswit.users.Permission
import ch.nokillswit.users.UserRole

fun CallerPrincipal.isAdmin(): Boolean = UserRole.ADMIN in roles

fun requireAdmin(caller: CallerPrincipal) {
    if (!caller.isAdmin()) throw ForbiddenException("Admin role required")
}

/**
 * The area gate for per-user feature flags (V5): run as the FIRST guard of a gated route,
 * before any read, so a disabled caller gets a uniform 403 even for a missing id. No route
 * is gated yet — MFA (the only flag today) is login-scoped and read off the DB record; the
 * first gateable feature area brings the first call site. The set rides the JWT, so a
 * change takes effect at the next refresh (≤15 min) or login.
 */
fun requireFeatureEnabled(caller: CallerPrincipal, feature: Feature) {
    if (feature in caller.disabledFeatures) {
        throw ForbiddenException("The ${feature.name} feature is disabled for this account")
    }
}

fun requireSelfOrAdmin(caller: CallerPrincipal, targetUserId: UInt) {
    if (caller.isAdmin()) return
    if (caller.userId != targetUserId) throw ForbiddenException("Caller may only act on their own user")
}

/**
 * ADMIN, or the team's current ACTIVE manager (V6). [isManager] answers false for a missing or deleted team too,
 * so run this as the FIRST guard of a team-scoped write, before any read: every other caller gets a uniform 403
 * whether or not the id exists. The lookup is injected so the guard stays DB-free (`GuardsTest` is pure). No route consumes it in
 * v0.1.0 (Flow's
 * capacity writes were the consumer); the team-scoped planning writes will, re-checking a non-admin's grant inside their locked write
 * transaction.
 */
suspend fun requireTeamManagerOrAdmin(
    caller: CallerPrincipal,
    teamId: UInt,
    isManager: suspend (teamId: UInt, userId: UInt) -> Boolean,
) {
    if (caller.isAdmin()) return
    if (!isManager(teamId, caller.userId)) throw ForbiddenException("Team manager or admin role required")
}

/**
 * ADMIN, or a user holding the [Permission.ROADMAP_EDITOR] grant (V11): the global project rank. [hasPermission] is
 * the injected `UserService.hasPermission` lookup (a database read per request, never a JWT claim), so the guard stays
 * DB-free and `GuardsTest` pure. ADMIN short-circuits before the lookup; a lookup failure propagates (fails closed:
 * the catch-all's 500, never a pass). Consumed by `PUT /roadmap/ranking`, which runs it as the FIRST guard — it needs nothing
 * from the path or the body — and AGAIN inside the `plan_state` lock (a request can be held open after the outer guard, so a grant
 * revoked meanwhile must refuse the write; `authorization.md`).
 */
suspend fun requireRoadmapEditorOrAdmin(
    caller: CallerPrincipal,
    hasPermission: suspend (userId: UInt, permission: Permission) -> Boolean,
) {
    if (caller.isAdmin()) return
    if (!hasPermission(caller.userId, Permission.ROADMAP_EDITOR)) {
        throw ForbiddenException("Roadmap editor or admin role required")
    }
}

/**
 * The person-id owners of a plan node's chain, top-down (work stream, program, project); resolved fresh per request by
 * the route and never cached. Ownership is person-id arithmetic: the caller's person is `people.user_id = caller AND
 * people.active()` (`PersonService.activePersonIdOf`). [ancestors] drops the node's own owner.
 */
data class OwnerChain(val owners: List<UInt>) {
    val ancestors: OwnerChain get() = OwnerChain(owners.dropLast(1))
}

/**
 * ADMIN, or the caller's person owns the node or anything above it ([chain]; ownership cascades down). A caller with
 * no active person ([callerPersonId] null) owns nothing. DB-free: the route resolves the chain and the person first
 * (read-before-guard: a missing node is a 404 before this runs; `authorization.md`). The plan routes run it TWICE: once outside
 * for the 404 -> 403 -> body ordering, and again inside the `plan_state` lock against a re-read chain and a re-resolved person
 * (a request can be held open between the two, so only the second verdict authorizes the write).
 */
fun requireOwnerOrAdmin(caller: CallerPrincipal, callerPersonId: UInt?, chain: OwnerChain) {
    if (caller.isAdmin()) return
    if (callerPersonId == null || callerPersonId !in chain.owners) throw ForbiddenException("Owner or admin role required")
}

/**
 * Who may set a project's target window: ADMIN, an owner ABOVE the project, or a holder of the [Permission.ROADMAP_EDITOR]
 * grant. It takes the node's FULL [chain] (project owner last) and uses [OwnerChain.ancestors] itself, so a caller can
 * never pass the wrong slice: the project's OWN owner is deliberately not enough alone. The cheap person-id check runs
 * before the database lookup; a lookup failure propagates (fails closed). Run twice by the target-window route, like
 * [requireOwnerOrAdmin]: outside for ordering, inside the plan lock (grant re-read) for the write.
 */
suspend fun requireTargetWindowEditorOrAdmin(
    caller: CallerPrincipal,
    callerPersonId: UInt?,
    chain: OwnerChain,
    hasPermission: suspend (userId: UInt, permission: Permission) -> Boolean,
) {
    if (caller.isAdmin()) return
    if (callerPersonId != null && callerPersonId in chain.ancestors.owners) return
    if (!hasPermission(caller.userId, Permission.ROADMAP_EDITOR)) {
        throw ForbiddenException("Target window editor or admin role required")
    }
}
