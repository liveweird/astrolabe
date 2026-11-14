package ch.nokillswit.jira

import ch.nokillswit.authz.CallerPrincipal
import ch.nokillswit.authz.ForbiddenException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.authz.isAdmin
import ch.nokillswit.authz.requireOwnerOrAdmin

/** A node the plan would touch: the [chain] to guard and how the `403` names it. */
private class Target(val chain: OwnerChain, val owned: String, val reason: String)

/**
 * The guard on the RESOLVED targets, after the kernel: the picked work stream when a program would be created, every existing node a
 * CREATE row lands under, and every node a BIND row binds to must be in a chain the caller owns (ADMIN owns all); the `403` names the
 * first one the caller does not own. A node created in the batch needs no guard: its chain contains a guarded node. A caller who owns
 * neither the stream, any target ([guardedByName]: a named default counts) nor any node of the stream's tree gets a `403` too, so an
 * import that only skips rows (a re-import: every row `ALREADY_BOUND`) still proves ownership. The chains come from the snapshot (the
 * picked stream's tree). The preview passes every row; the apply passes
 * the rows the client TICKED (CREATE or BIND after the recomputation, written or not), under the plan lock, so a ticked row cannot
 * probe a subtree the caller does not own. A ROOTED import (1.14) can no longer reach the `403` for a target outside the root: the
 * kernel skips such a row `OUTSIDE_ROOT` (1.15), so every CREATE lands under the root node or a project of it and the root's chain is
 * part of each target's chain; the guard stays as defence in depth.
 */
internal fun requireResolvedTargets(
    caller: CallerPrincipal,
    personId: UInt?,
    items: List<JiraImportItem>,
    read: ImportRead,
    guardedByName: Boolean,
) {
    val targets = items.flatMap { item -> targetsOf(item, read) }
    for (target in targets) {
        try {
            requireOwnerOrAdmin(caller, personId, target.chain)
        } catch (_: ForbiddenException) {
            throw ForbiddenException("You do not own ${target.owned}, ${target.reason}")
        }
    }
    val ownsStream = personId != null && personId in read.streamChain.owners
    val ownsATreeNode = personId != null && read.chains.values.any { personId in it.owners }
    val proven = caller.isAdmin() || guardedByName || targets.isNotEmpty()
    if (!(proven || ownsStream || ownsATreeNode)) {
        throw ForbiddenException("Owner or admin role required")
    }
}

/**
 * The nodes [item] touches that need a guard, in the order they are checked. A BIND the user confirmed as a suggested match
 * (`MATCH_CONFIRMED`, 1.15) first answers for the CREATE it replaces - the same chain and the same wording - so a blind `matches`
 * entry neither turns a `403` into a `200` for a caller who owns only the matched node, nor tells a different sentence; then the
 * BIND's own target.
 */
private fun targetsOf(item: JiraImportItem, read: ImportRead): List<Target> = when {
    item.action == JiraImportAction.CREATE -> listOfNotNull(createdUnder(item, read))
    item.action == JiraImportAction.BIND -> {
        val replaced = createdUnder(item, read).takeIf { JiraImportInfo.MATCH_CONFIRMED in item.infos }
        listOfNotNull(replaced, boundTo(item, read))
    }
    else -> emptyList()
}

/** The guard of a row that WOULD be created (or that replaces a CREATE): the stream for a program, else the parent's chain. */
private fun createdUnder(item: JiraImportItem, read: ImportRead): Target? {
    val created = "under which ${item.key()} would be created"
    if (item.level == JiraLevel.PROGRAM) return Target(read.streamChain, "the work stream", created)
    val parent = item.parent
    val level = if (item.level == JiraLevel.MILESTONE) JiraLevel.PROJECT else JiraLevel.PROGRAM
    // A parent the snapshot has no chain for would be a hole in the guard: fail closed, never skip it.
    return parent?.nodeId?.let { id -> Target(chainOf(read, level, id), "${level.label()} ${parent.nodeName}", created) }
}

private fun boundTo(item: JiraImportItem, read: ImportRead): Target? = item.target?.let { target ->
    val what = "${item.level.label()} ${target.nodeName}"
    Target(chainOf(read, item.level, target.nodeId), what, "which ${item.key()} would be bound to")
}

private fun chainOf(read: ImportRead, level: JiraLevel, nodeId: UInt): OwnerChain =
    checkNotNull(read.chains[level to nodeId]) { "the snapshot has no owner chain for ${level.label()} $nodeId" }
