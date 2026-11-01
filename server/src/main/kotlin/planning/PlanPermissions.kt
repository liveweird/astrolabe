package ch.nokillswit.planning

import ch.nokillswit.authz.OwnerChain

/**
 * Who the plan view is rendered for, resolved ONCE per request by the route: [isAdmin] from the verified roles, [personId] the
 * caller's ACTIVE person (null when none — and not looked up for an ADMIN, who needs no ownership), [roadmapEditor] whether a
 * NON-admin holds the `ROADMAP_EDITOR` grant (read from the database per request, never a token claim; not looked up for an ADMIN),
 * [managedTeamIds] the ACTIVE teams the caller currently manages (`TeamService.activeManagedTeamIds`; empty for an ADMIN, who needs none).
 */
data class PlanActor(val isAdmin: Boolean, val personId: UInt?, val roadmapEditor: Boolean, val managedTeamIds: Set<UInt>)

/**
 * The `can:{…}` flags of the plan view as a pure kernel (no I/O), computed from the SAME arithmetic as the route guards in
 * `authz/Guards.kt` — `requireAdmin`, `requireOwnerOrAdmin`, `requireTargetWindowEditorOrAdmin` and `requireTeamManagerOrAdmin` — so
 * the UI never offers what the server refuses. `PlanPermissionsTest` pins the agreement table-driven against the guards themselves;
 * change a guard and that test turns red until this kernel follows.
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

    /**
     * `POST /projects/{id}/move` and `POST /programs/{id}/move`, the SOURCE side: ADMIN, or the caller's person owns something ABOVE the
     * node (`requireAncestorOwnerOrAdmin`) — the node's own owner alone may not move it. The target side is [canManage] on the
     * candidate parent's chain (the `createProgram` / `createProject` flags).
     */
    fun canMove(actor: PlanActor, nodeChain: OwnerChain): Boolean =
        actor.isAdmin || (actor.personId != null && actor.personId in nodeChain.ancestors.owners)

    /** `PUT /roadmap/ranking`: ADMIN or the roadmap-editor grant (`requireRoadmapEditorOrAdmin`); ownership does not matter. */
    fun canEditRank(actor: PlanActor): Boolean = actor.isAdmin || actor.roadmapEditor

    /**
     * `POST /projects/{id}/milestones`: the owner chain of the project, the project's own owner included, or ADMIN
     * (`requireOwnerOrAdmin`) — the same arithmetic as [canManage].
     */
    fun canCreateMilestone(actor: PlanActor, projectChain: OwnerChain): Boolean = canManage(actor, projectChain)

    /**
     * `POST /projects/{id}/dependencies`: the owner chain of the project the successor lives in, the project's own owner included, or ADMIN
     * (`requireOwnerOrAdmin`) — the same arithmetic as [canManage]. The predecessor's owner is asked nothing.
     */
    fun canCreateDependency(actor: PlanActor, projectChain: OwnerChain): Boolean = canManage(actor, projectChain)

    /**
     * `DELETE /dependencies/{id}`: the owner chain of the SUCCESSOR's project, or ADMIN (`requireOwnerOrAdmin` on `dependencyChain`) —
     * [successorProjectChain] is the chain of the project holding the successor, never the predecessor's.
     */
    fun canDeleteDependency(actor: PlanActor, successorProjectChain: OwnerChain): Boolean = canManage(actor, successorProjectChain)

    /**
     * `PUT /milestones/{id}/schedule`: ADMIN or the ACTIVE manager of the milestone's [teamId] (`requireTeamManagerOrAdmin`) — never
     * the project's owner as such.
     */
    fun canSchedule(actor: PlanActor, teamId: UInt): Boolean = actor.isAdmin || teamId in actor.managedTeamIds
}
