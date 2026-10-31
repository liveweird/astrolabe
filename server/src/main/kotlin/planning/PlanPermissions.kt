package ch.nokillswit.planning

import ch.nokillswit.authz.OwnerChain

/**
 * Who the plan view is rendered for, resolved ONCE per request by the route: [isAdmin] from the verified roles, [personId] the
 * caller's ACTIVE person (null when none — and not looked up for an ADMIN, who needs no ownership), [roadmapEditor] whether a
 * NON-admin holds the `ROADMAP_EDITOR` grant (read from the database per request, never a token claim; not looked up for an ADMIN).
 */
data class PlanActor(val isAdmin: Boolean, val personId: UInt?, val roadmapEditor: Boolean)

/**
 * The `can:{…}` flags of the plan view as a pure kernel (no I/O), computed from the SAME arithmetic as the route guards in
 * `authz/Guards.kt` — `requireAdmin`, `requireOwnerOrAdmin` and `requireTargetWindowEditorOrAdmin` — so the UI never offers what
 * the server refuses. `PlanPermissionsTest` pins the agreement table-driven against the guards themselves; change a guard and that
 * test turns red until this kernel follows.
 */
object PlanPermissions {
    /** `POST /work-streams`: ADMIN only (`requireAdmin`). */
    fun canCreateWorkStream(actor: PlanActor): Boolean = actor.isAdmin

    /**
     * Edit, delete and create-a-child on a node whose owners (top-down, the node's own last) are [chain]: ADMIN, or the caller's
     * person owns the node or anything above it (`requireOwnerOrAdmin`).
     */
    fun canManage(actor: PlanActor, chain: OwnerChain): Boolean =
        actor.isAdmin || (actor.personId != null && actor.personId in chain.owners)

    /**
     * `PUT /projects/{id}/target-window`: ADMIN, an owner ABOVE the project, or the roadmap-editor grant
     * (`requireTargetWindowEditorOrAdmin`) — the project's own owner alone is not enough.
     */
    fun canEditTargetWindow(actor: PlanActor, projectChain: OwnerChain): Boolean =
        actor.isAdmin || (actor.personId != null && actor.personId in projectChain.ancestors.owners) || actor.roadmapEditor
}
