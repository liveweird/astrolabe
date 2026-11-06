package ch.nokillswit.jira

import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.containsNormalized
import ch.nokillswit.planning.MilestoneService
import ch.nokillswit.planning.ProgramService
import ch.nokillswit.planning.ProjectService
import ch.nokillswit.planning.WorkStreamService
import ch.nokillswit.planning.milestoneChain
import ch.nokillswit.planning.programChain
import ch.nokillswit.planning.projectChain
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*

/*
 * The binding service's reads of the plan (`persistence.md`: `jira/` READS `planning`, writes nothing there). Every function runs INSIDE
 * the caller's transaction. The ACTIVE chain is `planning/OwnerChains.kt`'s (the node and every ancestor active); the last-known chain
 * and the names read WITHOUT an `active()` filter, for a binding whose node may be gone.
 */

private val milestones = MilestoneService.Milestones
private val projects = ProjectService.Projects
private val programs = ProgramService.Programs
private val streams = WorkStreamService.WorkStreams

/** The owners of a node's chain, or null when the node or any ancestor is missing or deleted (the route's 404, the inline-release test). */
internal suspend fun activeChain(level: JiraLevel, nodeId: UInt): OwnerChain? = when (level) {
    JiraLevel.PROGRAM -> programChain(nodeId)
    JiraLevel.PROJECT -> projectChain(nodeId)
    JiraLevel.MILESTONE -> milestoneChain(nodeId)?.owners
}

/**
 * Locks the ACTIVE node row `FOR SHARE`, which conflicts with the `UPDATE` of its soft delete and of its owner change: a delete racing a
 * bind either commits first (false here: 404) or waits for the bind's commit (the binding is then released by the run's sweep). Only the
 * node's own row is locked, never its ancestors', so this cannot close a lock cycle with a plan writer that updates a chain top-down.
 */
internal suspend fun lockNodeShared(level: JiraLevel, nodeId: UInt): Boolean = when (level) {
    JiraLevel.PROGRAM -> programs.select(programs.id).where { (programs.id eq nodeId) and programs.active() }
    JiraLevel.PROJECT -> projects.select(projects.id).where { (projects.id eq nodeId) and projects.active() }
    JiraLevel.MILESTONE -> milestones.select(milestones.id).where { (milestones.id eq nodeId) and milestones.active() }
}.forUpdate(ForUpdateOption.PostgreSQL.ForShare).toList().isNotEmpty()

/**
 * The owners of a node's chain as last stored, WITHOUT any `active()` filter: the unbind guard's chain for a binding whose node was
 * deleted since (null only for an id no row ever had - impossible under the foreign key). For the guard only: nothing else is read
 * from a deleted node.
 */
internal suspend fun lastKnownChain(level: JiraLevel, nodeId: UInt): OwnerChain? = when (level) {
    JiraLevel.PROGRAM -> programs.innerJoin(streams, { programs.workStreamId }, { streams.id })
        .select(streams.ownerPersonId, programs.ownerPersonId).where { programs.id eq nodeId }.toList().singleOrNull()
        ?.let { OwnerChain(listOf(it[streams.ownerPersonId].value, it[programs.ownerPersonId].value)) }
    JiraLevel.PROJECT -> projects.innerJoin(programs, { projects.programId }, { programs.id })
        .innerJoin(streams, { programs.workStreamId }, { streams.id })
        .select(streams.ownerPersonId, programs.ownerPersonId, projects.ownerPersonId).where { projects.id eq nodeId }.toList()
        .singleOrNull()
        ?.let { OwnerChain(listOf(it[streams.ownerPersonId].value, it[programs.ownerPersonId].value, it[projects.ownerPersonId].value)) }
    JiraLevel.MILESTONE -> milestones.innerJoin(projects, { milestones.projectId }, { projects.id })
        .innerJoin(programs, { projects.programId }, { programs.id })
        .innerJoin(streams, { programs.workStreamId }, { streams.id })
        .select(streams.ownerPersonId, programs.ownerPersonId, projects.ownerPersonId).where { milestones.id eq nodeId }.toList()
        .singleOrNull()
        ?.let { OwnerChain(listOf(it[streams.ownerPersonId].value, it[programs.ownerPersonId].value, it[projects.ownerPersonId].value)) }
}

/**
 * Where each node sits, batched per level (three statements at most, whatever the number of nodes). The names are read WITHOUT an
 * `active()` filter: the callers name live nodes (a page of live bindings, the other side of a conflict), and a name of a node deleted
 * a moment ago is harmless. A node with no row is simply absent.
 */
internal suspend fun describeNodes(nodes: Collection<Pair<JiraLevel, UInt>>): Map<Pair<JiraLevel, UInt>, JiraBindingNode> {
    val result = HashMap<Pair<JiraLevel, UInt>, JiraBindingNode>()
    fun ids(level: JiraLevel) = nodes.filter { it.first == level }.map { it.second }.distinct()
    ids(JiraLevel.PROGRAM).takeIf { it.isNotEmpty() }?.let { ids ->
        programs.innerJoin(streams, { programs.workStreamId }, { streams.id })
            .select(programs.id, programs.name, streams.name).where { programs.id inList ids }.toList().forEach {
                val id = it[programs.id].value
                result[JiraLevel.PROGRAM to id] =
                    JiraBindingNode(JiraLevel.PROGRAM, id, it[programs.name], workStreamName = it[streams.name])
            }
    }
    ids(JiraLevel.PROJECT).takeIf { it.isNotEmpty() }?.let { ids ->
        projects.innerJoin(programs, { projects.programId }, { programs.id })
            .innerJoin(streams, { programs.workStreamId }, { streams.id })
            .select(projects.id, projects.name, programs.name, streams.name).where { projects.id inList ids }.toList().forEach {
                val id = it[projects.id].value
                result[JiraLevel.PROJECT to id] = JiraBindingNode(
                    JiraLevel.PROJECT, id, it[projects.name], programName = it[programs.name], workStreamName = it[streams.name],
                )
            }
    }
    ids(JiraLevel.MILESTONE).takeIf { it.isNotEmpty() }?.let { ids ->
        milestones.innerJoin(projects, { milestones.projectId }, { projects.id })
            .innerJoin(programs, { projects.programId }, { programs.id })
            .innerJoin(streams, { programs.workStreamId }, { streams.id })
            .select(milestones.id, milestones.name, projects.name, programs.name, streams.name)
            .where { milestones.id inList ids }.toList().forEach {
                val id = it[milestones.id].value
                result[JiraLevel.MILESTONE to id] = JiraBindingNode(
                    JiraLevel.MILESTONE, id, it[milestones.name],
                    projectName = it[projects.name], programName = it[programs.name], workStreamName = it[streams.name],
                )
            }
    }
    return result
}

/** The ids of the LIVE nodes (node and every ancestor ACTIVE) of each level, as sub-queries for the list's filter. */
internal fun liveMilestoneIds(): Query = milestones.innerJoin(projects, { milestones.projectId }, { projects.id })
    .innerJoin(programs, { projects.programId }, { programs.id })
    .innerJoin(streams, { programs.workStreamId }, { streams.id })
    .select(milestones.id).where { milestones.active() and projects.active() and programs.active() and streams.active() }

internal fun liveProjectIds(): Query = projects.innerJoin(programs, { projects.programId }, { programs.id })
    .innerJoin(streams, { programs.workStreamId }, { streams.id })
    .select(projects.id).where { projects.active() and programs.active() and streams.active() }

internal fun liveProgramIds(): Query = programs.innerJoin(streams, { programs.workStreamId }, { streams.id })
    .select(programs.id).where { programs.active() and streams.active() }

/** The live nodes of each level whose own name contains [q] (case- and accent-insensitive): the list's `q`. */
internal fun namedMilestoneIds(q: String): Query = liveMilestoneIds().andWhere { milestones.name.containsNormalized(q) }

internal fun namedProjectIds(q: String): Query = liveProjectIds().andWhere { projects.name.containsNormalized(q) }

internal fun namedProgramIds(q: String): Query = liveProgramIds().andWhere { programs.name.containsNormalized(q) }

/**
 * Of [nodeIds] at [level], those whose node and every ancestor are ACTIVE: the run's node sweep releases the bindings of the rest. One
 * statement for at most a connection's bindings (≤ 1,200); a null-safe test done in Kotlin, because `NOT (a OR b OR c)` over the three
 * nullable node columns is NULL, not true, for a dead node.
 */
internal suspend fun liveNodeIds(level: JiraLevel, nodeIds: Collection<UInt>): Set<UInt> {
    if (nodeIds.isEmpty()) return emptySet()
    return when (level) {
        JiraLevel.PROGRAM -> liveProgramIds().andWhere { programs.id inList nodeIds }.toList().map { it[programs.id].value }
        JiraLevel.PROJECT -> liveProjectIds().andWhere { projects.id inList nodeIds }.toList().map { it[projects.id].value }
        JiraLevel.MILESTONE -> liveMilestoneIds().andWhere { milestones.id inList nodeIds }.toList().map { it[milestones.id].value }
    }.toSet()
}
