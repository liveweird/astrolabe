package ch.nokillswit.planning

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.authz.ProblemCycleNode
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.nowMillis
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.EntityID
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val DependencyServiceKey = AttributeKey<DependencyService>("DependencyService")

private const val DEPENDENCY_NOT_FOUND = "Dependency not found"

/** The 409 detail of an already-linked pair: the unique index's wording (`UNIQUE_CONSTRAINT_DETAILS`), shared by the reverse-pair check. */
private const val ALREADY_LINKED = "These two endpoints are already linked"

/**
 * A stored link's successor-side authorization data: the [owners] of the SUCCESSOR's project chain (the guard of `DELETE`), and both
 * ends as stored. See [dependencyChain].
 */
data class DependencyChain(val owners: OwnerChain, val predecessor: EndpointRef, val successor: EndpointRef)

/**
 * Dependencies (V15): links between two milestones, a milestone and a project, or two projects. A dependency IS plan state, so every
 * write runs in [withPlanWrite]; the SUCCESSOR's project chain authorizes it (`POST /projects/{id}/dependencies`, `DELETE
 * /dependencies/{id}`: the predecessor's owner is asked nothing, since a link never moves anything) and the guard is re-run under the
 * lock against the chain re-read there. A link that would close a directed cycle on the time-point graph ([TimePointGraph]) is a
 * `409 urn:astrolabe:problem:dependency-cycle` before the insert; a second ACTIVE link on the same ordered pair is the partial unique
 * index's `409`. Reads are open to every authenticated user.
 */
class DependencyService(private val database: R2dbcDatabase) {
    object Dependencies : UIntIdTable("dependencies"), SoftDeletable {
        val predMilestoneId = optReference("pred_milestone_id", MilestoneService.Milestones)
        val predProjectId = optReference("pred_project_id", ProjectService.Projects)
        val succMilestoneId = optReference("succ_milestone_id", MilestoneService.Milestones)
        val succProjectId = optReference("succ_project_id", ProjectService.Projects)

        /** FS / SS / FF / SF — [DependencyType] is the whitelist, `ck_dependencies_type` the backstop. */
        val type = varchar("type", length = 2)

        /** Working days, negative = a lead (`ck_dependencies_lag`: -365..365). */
        val lagDays = integer("lag_days")
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    /** The successor-side chain of the link, or null when the link or its successor's project, program or work stream is gone. */
    suspend fun chain(id: UInt): DependencyChain? = suspendTransaction(database) { dependencyChain(id) }

    /** The link with both ends resolved, or null when it, or either end's project, program or work stream, is missing/deleted. */
    suspend fun read(id: UInt): DependencyResponse? = suspendTransaction(database) {
        val row = Dependencies.selectAll().where { (Dependencies.id eq id) and Dependencies.active() }.toList().singleOrNull()
            ?: return@suspendTransaction null
        val predecessor = row.predecessorRef()
        val successor = row.successorRef()
        if (!isActiveEndpoint(predecessor) || !isActiveEndpoint(successor)) return@suspendTransaction null
        val ends = resolveEndpoints(listOf(predecessor, successor))
        DependencyResponse(
            id = id,
            predecessor = ends.getValue(predecessor),
            successor = ends.getValue(successor),
            type = DependencyType.valueOf(row[Dependencies.type]),
            lagDays = row[Dependencies.lagDays],
            createdAt = row[Dependencies.createdAt],
            updatedAt = row[Dependencies.updatedAt],
        )
    }

    /**
     * Creates a link whose successor is project [projectId] or one of its ACTIVE milestones. Under the plan lock, in this order: the
     * project's chain is re-read (missing = 404) and [guard] re-run on it (403) -> the successor must be that project or one of its
     * milestones (400) -> the predecessor must be an ACTIVE milestone or project (400 "Unknown or deleted … ids: N") -> a link that
     * would close a cycle is refused (409 `urn:astrolabe:problem:dependency-cycle` with the cycle as data, nothing written, no bump)
     * -> an ACTIVE link on the REVERSE pair is the plain "already linked" 409 (at most one active link per UNORDERED pair; a reverse
     * pair is a cycle for most type combinations, but `a SS b` + `b FF a` and `a SF b` + `b SF a` close none) -> the insert, where a
     * second ACTIVE link on the same ordered pair is the partial unique index's 409.
     */
    suspend fun create(projectId: UInt, request: DependencyCreateRequest, guard: PlanGuard): UInt {
        validateDependencyCreate(request)
        return database.withPlanWrite {
            guard(projectChain(projectId) ?: throw NotFoundException("Project not found"))
            requireSuccessorInProject(request.successor, projectId)
            requireActivePredecessor(request.predecessor)
            val edge = DependencyEdge(request.predecessor, request.successor, request.type)
            refuseCycle(edge)
            refuseReversePair(request)
            val stamp = nowMillis()
            Dependencies.insert {
                it[predMilestoneId] = request.predecessor.idOf(EndpointKind.MILESTONE)
                it[predProjectId] = request.predecessor.idOf(EndpointKind.PROJECT)
                it[succMilestoneId] = request.successor.idOf(EndpointKind.MILESTONE)
                it[succProjectId] = request.successor.idOf(EndpointKind.PROJECT)
                it[type] = request.type.name
                it[lagDays] = request.lagDays
                it[createdAt] = stamp
                it[updatedAt] = stamp
            }[Dependencies.id].value
        }.value
    }

    /**
     * Soft delete under the plan lock: the SUCCESSOR's chain is re-read (missing = 404, nothing written) and [guard] re-run on it.
     * Frees the ordered pair. Returns the chain read under the lock (both ends as stored) for the audit.
     */
    suspend fun delete(id: UInt, guard: PlanGuard): DependencyChain = database.withPlanWrite {
        val chain = dependencyChain(id) ?: throw NotFoundException(DEPENDENCY_NOT_FOUND)
        guard(chain.owners)
        val affected = Dependencies.update({ (Dependencies.id eq id) and Dependencies.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = nowMillis()
        }
        if (affected == 0) throw NotFoundException(DEPENDENCY_NOT_FOUND)
        chain
    }.value

    /** The successor must be project [projectId] itself or an ACTIVE milestone of it — the project chain that authorized the write. */
    private suspend fun requireSuccessorInProject(successor: EndpointRef, projectId: UInt) {
        val inProject = when (successor.kind) {
            EndpointKind.PROJECT -> successor.id == projectId
            EndpointKind.MILESTONE -> milestoneChain(successor.id)?.projectId == projectId
        }
        if (!inProject) throw BadRequestException("Successor must be this project or one of its milestones")
    }

    private suspend fun requireActivePredecessor(predecessor: EndpointRef) {
        if (!isActiveEndpoint(predecessor)) {
            val kind = if (predecessor.kind == EndpointKind.MILESTONE) "milestone" else "project"
            throw BadRequestException("Unknown or deleted $kind ids: ${predecessor.id}")
        }
    }

    /** 409 [ALREADY_LINKED] when an ACTIVE link already runs from this request's successor to its predecessor (any type). */
    private suspend fun refuseReversePair(request: DependencyCreateRequest) {
        val links = Dependencies
        val reverse = endpointIs(links.predMilestoneId, links.predProjectId, request.successor) and
            endpointIs(links.succMilestoneId, links.succProjectId, request.predecessor)
        val exists = links.select(links.id).where { links.active() and reverse }.limit(1).toList().isNotEmpty()
        if (exists) throw ConflictException(ALREADY_LINKED)
    }

    /** 409 when [edge] would close a directed cycle on the active plan's graph; the exception carries the cycle as data. */
    private suspend fun refuseCycle(edge: DependencyEdge) {
        val cycle = loadTimePointGraph().cycleClosedBy(edge) ?: return
        val names = resolveEndpoints(cycle.distinct())
        val nodes = cycle.map { ProblemCycleNode(it.kind.name, it.id, names.getValue(it).name) }
        throw ConflictException(
            "Adding this dependency would close a cycle: ${nodes.joinToString(" → ") { it.name }}",
            problemType = DEPENDENCY_CYCLE_PROBLEM,
            cycle = nodes,
        )
    }
}

/** The column pair holds exactly [ref]: its kind's column equals the id and the other column is NULL (`ck_dependencies_pred/succ`). */
private fun endpointIs(milestoneColumn: Column<EntityID<UInt>?>, projectColumn: Column<EntityID<UInt>?>, ref: EndpointRef): Op<Boolean> =
    when (ref.kind) {
        EndpointKind.MILESTONE -> (milestoneColumn eq EntityID(ref.id, MilestoneService.Milestones)) and projectColumn.isNull()
        EndpointKind.PROJECT -> (projectColumn eq EntityID(ref.id, ProjectService.Projects)) and milestoneColumn.isNull()
    }

private fun EndpointRef.idOf(kind: EndpointKind): UInt? = if (this.kind == kind) id else null

private fun endpointOf(milestone: EntityID<UInt>?, project: EntityID<UInt>?): EndpointRef =
    if (milestone != null) {
        EndpointRef(EndpointKind.MILESTONE, milestone.value)
    } else {
        EndpointRef(EndpointKind.PROJECT, checkNotNull(project).value)
    }

/** The predecessor of a stored link (`ck_dependencies_pred`: exactly one of the two columns is set). */
internal fun ResultRow.predecessorRef(): EndpointRef =
    endpointOf(this[DependencyService.Dependencies.predMilestoneId], this[DependencyService.Dependencies.predProjectId])

/** The successor of a stored link (`ck_dependencies_succ`: exactly one of the two columns is set). */
internal fun ResultRow.successorRef(): EndpointRef =
    endpointOf(this[DependencyService.Dependencies.succMilestoneId], this[DependencyService.Dependencies.succProjectId])

/** Whether [ref] names an ACTIVE milestone or project whose whole chain is active (the chain lookups join every ancestor). */
internal suspend fun isActiveEndpoint(ref: EndpointRef): Boolean = when (ref.kind) {
    EndpointKind.MILESTONE -> milestoneChain(ref.id) != null
    EndpointKind.PROJECT -> projectChain(ref.id) != null
}

/**
 * What a milestone or project delete cascaded, for the audit: the soft-deleted links' [ids] (ascending) and the distinct
 * [successorProjectIds] (ascending) of the projects whose plan lost a constraint — a successor milestone's project, or the successor
 * project itself. [count] is the audit's `dependencyCount`.
 */
data class DeletedDependencies(val ids: List<UInt>, val successorProjectIds: List<UInt>) {
    val count: Int get() = ids.size

    /** The audit fields of a cascading delete: `dependencyCount`, `dependencyIds` and `successorProjectIds` (comma-joined, "" = none). */
    fun auditFields(): Array<Pair<String, Any?>> = arrayOf(
        "dependencyCount" to count,
        "dependencyIds" to ids.joinToString(","),
        "successorProjectIds" to successorProjectIds.joinToString(","),
    )
}

/**
 * The predicate "this link has an end among [milestoneIds] or [projectIds]" (either side), or null when both are empty. The cascade of a
 * milestone or project delete and the project view's link read share it; the caller adds the `active()` predicate.
 */
internal fun linksTouching(milestoneIds: Collection<UInt>, projectIds: Collection<UInt>): Op<Boolean>? {
    val links = DependencyService.Dependencies
    return listOfNotNull(
        milestoneIds.takeIf { it.isNotEmpty() }?.let { ids ->
            (links.predMilestoneId inList ids.map { EntityID(it, MilestoneService.Milestones) }) or
                (links.succMilestoneId inList ids.map { EntityID(it, MilestoneService.Milestones) })
        },
        projectIds.takeIf { it.isNotEmpty() }?.let { ids ->
            (links.predProjectId inList ids.map { EntityID(it, ProjectService.Projects) }) or
                (links.succProjectId inList ids.map { EntityID(it, ProjectService.Projects) })
        },
    ).reduceOrNull { left, right -> left or right }
}

/**
 * Soft-deletes every ACTIVE link that has an end among [milestoneIds] or [projectIds] and returns which — the cascade of a
 * milestone delete and of a project delete (`MilestoneService.delete`, `ProjectService.delete`, same plan-locked transaction): a link
 * cannot outlive an end, whichever side's owner wrote it. Both lists empty is a no-op.
 */
internal suspend fun deleteDependenciesOf(milestoneIds: Collection<UInt>, projectIds: Collection<UInt>): DeletedDependencies {
    val links = DependencyService.Dependencies
    val touching = linksTouching(milestoneIds, projectIds) ?: return DeletedDependencies(emptyList(), emptyList())
    val rows = links.selectAll().where { links.active() and touching }.orderBy(links.id).toList()
    if (rows.isEmpty()) return DeletedDependencies(emptyList(), emptyList())
    val ids = rows.map { it[links.id].value }
    links.update({ links.id inList rows.map { it[links.id] } }) {
        it[markedAsDeleted] = true
        it[updatedAt] = nowMillis()
    }
    return DeletedDependencies(ids, successorProjectIds(rows.map { it.successorRef() }))
}

/** The distinct project ids of [successors], ascending: a project's is its own, a milestone's is read (no `active()` filter needed). */
private suspend fun successorProjectIds(successors: List<EndpointRef>): List<UInt> {
    val milestones = MilestoneService.Milestones
    val milestoneIds = successors.filter { it.kind == EndpointKind.MILESTONE }.map { EntityID(it.id, milestones) }.distinct()
    val ofMilestones = if (milestoneIds.isEmpty()) {
        emptyList()
    } else {
        milestones.select(milestones.projectId).where { milestones.id inList milestoneIds }.toList().map { it[milestones.projectId].value }
    }
    return (successors.filter { it.kind == EndpointKind.PROJECT }.map { it.id } + ofMilestones).distinct().sorted()
}
