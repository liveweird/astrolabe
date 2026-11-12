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
 * probe a subtree the caller does not own.
 */
internal fun requireResolvedTargets(
    caller: CallerPrincipal,
    personId: UInt?,
    items: List<JiraImportItem>,
    read: ImportRead,
    guardedByName: Boolean,
) {
    val targets = items.mapNotNull { item -> targetOf(item, read) }
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

/** The node [item] touches that needs a guard, or null (a skipped row, a program-less parent, a parent created in the batch). */
private fun targetOf(item: JiraImportItem, read: ImportRead): Target? {
    val created = "under which ${item.key()} would be created"
    return when {
        item.action == JiraImportAction.CREATE && item.level == JiraLevel.PROGRAM -> Target(read.streamChain, "the work stream", created)
        item.action == JiraImportAction.CREATE -> {
            val parent = item.parent
            val level = if (item.level == JiraLevel.MILESTONE) JiraLevel.PROJECT else JiraLevel.PROGRAM
            // A parent the snapshot has no chain for would be a hole in the guard: fail closed, never skip it.
            parent?.nodeId?.let { id ->
                Target(chainOf(read, level, id), "${level.label()} ${parent.nodeName}", created)
            }
        }
        item.action == JiraImportAction.BIND -> item.target?.let { target ->
            val what = "${item.level.label()} ${target.nodeName}"
            Target(chainOf(read, item.level, target.nodeId), what, "which ${item.key()} would be bound to")
        }
        else -> null
    }
}

private fun chainOf(read: ImportRead, level: JiraLevel, nodeId: UInt): OwnerChain =
    checkNotNull(read.chains[level to nodeId]) { "the snapshot has no owner chain for ${level.label()} $nodeId" }
