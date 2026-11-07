package ch.nokillswit.planning

import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.containsNormalized
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.localDate
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.paging.PageRequest
import ch.nokillswit.infra.paging.applyPaging
import ch.nokillswit.people.PersonService
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val ProjectServiceKey = AttributeKey<ProjectService>("ProjectService")

private val SORTABLE_COLUMNS: Map<String, Column<*>> = mapOf(
    "id" to ProjectService.Projects.id,
    "name" to ProjectService.Projects.name,
    "createdAt" to ProjectService.Projects.createdAt,
    "updatedAt" to ProjectService.Projects.updatedAt,
)

/** The ONE sortable whitelist of `GET /projects`, derived from the column map so the two can never drift. */
val PROJECT_SORT_FIELDS: Set<String> = SORTABLE_COLUMNS.keys

/**
 * Projects (V12), under one program. Same protocol as [ProgramService]; a project name is unique among the ACTIVE projects of its
 * program (`uq_projects_program_name_active`, 409). The target window is its own write ([setTargetWindow]) because its audience
 * differs from the field edit's (`authorization.md`).
 */
class ProjectService(private val database: R2dbcDatabase) {
    object Projects : UIntIdTable("projects"), SoftDeletable {
        val programId = reference("program_id", ProgramService.Programs)
        val name = varchar("name", length = MAX_PLAN_NAME_LENGTH)
        val description = varchar("description", length = MAX_PLAN_DESCRIPTION_LENGTH).nullable()

        /** Required; always an ACTIVE person while the project is active. */
        val ownerPersonId = reference("owner_person_id", PersonService.People)

        /** Both set or both null (`ck_projects_target_window`), end not before start (`ck_projects_target_order`). */
        val targetStart = localDate("target_start").nullable()
        val targetEnd = localDate("target_end").nullable()
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    /**
     * The paged project list (the dependency pickers): ACTIVE projects under an ACTIVE program and work stream, one predicate for the
     * count and the rows in ONE read transaction (no lock, no revision: a picker is not a plan view). The ancestors' names ride the join.
     */
    suspend fun list(filter: ProjectListFilter, paging: PageRequest): ProjectListResult = suspendTransaction(database) {
        val programs = ProgramService.Programs
        val streams = WorkStreamService.WorkStreams
        var predicate: Op<Boolean> = Projects.active() and programs.active() and streams.active()
        filter.name?.takeIf { it.isNotBlank() }?.let { predicate = predicate and Projects.name.containsNormalized(it) }
        val joined = Projects.innerJoin(programs, { Projects.programId }, { programs.id })
            .innerJoin(streams, { programs.workStreamId }, { streams.id })
        val total = joined.selectAll().where { predicate }.count()
        val rows = joined.select(Projects.columns + programs.name + programs.workStreamId + streams.name)
            .where { predicate }
            .applyPaging(paging, SORTABLE_COLUMNS)
            .toList()
        val owners = ownerNames(rows.map { it[Projects.ownerPersonId].value })
        ProjectListResult(
            items = rows.map { row ->
                val ownerId = row[Projects.ownerPersonId].value
                ProjectListItem(
                    id = row[Projects.id].value,
                    programId = row[Projects.programId].value,
                    workStreamId = row[programs.workStreamId].value,
                    name = row[Projects.name],
                    description = row[Projects.description],
                    ownerPersonId = ownerId,
                    ownerName = owners.getValue(ownerId),
                    targetStart = row[Projects.targetStart]?.toString(),
                    targetEnd = row[Projects.targetEnd]?.toString(),
                    programName = row[programs.name],
                    workStreamName = row[streams.name],
                    createdAt = row[Projects.createdAt],
                    updatedAt = row[Projects.updatedAt],
                )
            },
            total = total,
        )
    }

    /** The project's owner chain (work stream first, the project's own owner last), or null when it or an ancestor is gone. */
    suspend fun chain(id: UInt): OwnerChain? = suspendTransaction(database) { projectChain(id) }

    /** The project, or null when missing/deleted. */
    suspend fun read(id: UInt): ProjectResponse? = suspendTransaction(database) {
        val programs = ProgramService.Programs
        val row = Projects.innerJoin(programs, { Projects.programId }, { programs.id })
            .select(Projects.columns + programs.workStreamId)
            .where { (Projects.id eq id) and Projects.active() }
            .toList().singleOrNull()
            ?: return@suspendTransaction null
        val ownerId = row[Projects.ownerPersonId].value
        ProjectResponse(
            id = id,
            programId = row[Projects.programId].value,
            workStreamId = row[programs.workStreamId].value,
            name = row[Projects.name],
            description = row[Projects.description],
            ownerPersonId = ownerId,
            ownerName = ownerNames(listOf(ownerId)).getValue(ownerId),
            targetStart = row[Projects.targetStart]?.toString(),
            targetEnd = row[Projects.targetEnd]?.toString(),
            createdAt = row[Projects.createdAt],
            updatedAt = row[Projects.updatedAt],
        )
    }

    /**
     * Creates a project under [programId]; under the lock the program's chain is re-read (missing = 404) and [guard] re-run,
     * then an inactive owner is a 400 and a name clash in the program a 409.
     */
    suspend fun create(programId: UInt, request: ProjectCreateRequest, guard: PlanGuard): UInt {
        val window = validateProjectCreate(request)
        return database.withPlanWrite {
            guard(programChain(programId) ?: throw NotFoundException("Program not found"))
            requireActiveOwner(request.ownerPersonId)
            val stamp = nowMillis()
            insertProjectRow(programId, request.name, request.description, request.ownerPersonId, window, stamp)
        }.value
    }

    /**
     * Field replace under the plan lock (name, description, owner — never the parent or the window); the chain is re-read and
     * [guard] re-run first (missing = 404).
     */
    suspend fun update(id: UInt, request: ProjectUpdateRequest, guard: PlanGuard): ProjectUpdateOutcome {
        validateProjectFields(request.name, request.description)
        return database.withPlanWrite {
            guard(projectChain(id) ?: throw NotFoundException("Project not found"))
            val before = Projects.select(Projects.ownerPersonId).where { (Projects.id eq id) and Projects.active() }
                .toList().singleOrNull() ?: throw NotFoundException("Project not found")
            requireActiveOwner(request.ownerPersonId)
            Projects.update({ (Projects.id eq id) and Projects.active() }) {
                it[name] = request.name
                it[description] = request.description
                it[ownerPersonId] = request.ownerPersonId
                it[updatedAt] = nowMillis()
            }
            ProjectUpdateOutcome(before[Projects.ownerPersonId].value)
        }.value
    }

    /** Replaces the target window (both dates or neither) under the plan lock; the outcome carries the STORED window for the audit. */
    suspend fun setTargetWindow(id: UInt, request: TargetWindowRequest, guard: PlanGuard): TargetWindowOutcome {
        val window = validateTargetWindow(request.targetStart, request.targetEnd)
        return database.withPlanWrite {
            guard(projectChain(id) ?: throw NotFoundException("Project not found"))
            val before = Projects.select(Projects.targetStart, Projects.targetEnd)
                .where { (Projects.id eq id) and Projects.active() }
                .toList().singleOrNull() ?: throw NotFoundException("Project not found")
            Projects.update({ (Projects.id eq id) and Projects.active() }) {
                it[targetStart] = window?.start
                it[targetEnd] = window?.end
                it[updatedAt] = nowMillis()
            }
            val start = before[Projects.targetStart]
            val end = before[Projects.targetEnd]
            TargetWindowOutcome(if (start != null && end != null) TargetWindow(start, end) else null)
        }.value
    }

    /**
     * Moves the project under [programId] under the plan lock. The SOURCE chain is re-read (missing = 404) and the source guard
     * re-run on it (an owner ABOVE the project), then the TARGET program's chain (missing = 400, a body field) and the target guard
     * on that too: both must pass. A name clash in the target program is the partial index's 409 (`uq_projects_program_name_active`);
     * the milestones ride along (their FK is the project), the global ranking is untouched, and a move to the current parent writes
     * nothing (the outcome says so).
     */
    suspend fun move(id: UInt, programId: UInt, guards: MoveGuards): MoveOutcome = database.withPlanWrite {
        val source = projectChainRow(id, listOf(Projects.programId)) ?: throw NotFoundException("Project not found")
        guards.source(source.chain)
        guards.target(programChain(programId) ?: unknownMoveTarget("program", programId))
        val from = source.row[Projects.programId].value
        if (from != programId) {
            Projects.update({ (Projects.id eq id) and Projects.active() }) {
                it[this.programId] = programId
                it[updatedAt] = nowMillis()
            }
        }
        MoveOutcome(from, programId)
    }.value

    /**
     * Soft delete under the plan lock. A project's ACTIVE milestones are soft-deleted in the same locked transaction
     * ([deleteMilestonesOf]: the project's own work breakdown, no owner of their own — the returned count is the audit's
     * `milestoneCount`), so there is no 409; first the ACTIVE dependencies with an end at the project OR at one of its milestones
     * ([deleteDependenciesOf], the audit's `dependencyCount`, `dependencyIds` and `successorProjectIds`). The same transaction takes
     * the project out of the ranking ([removeFromRanking]: its `roadmap_entries` row is hard-deleted and the positions above it shift
     * down), so the dense 1..n ranking never holds a deleted project, and its milestones out of their teams' orders
     * ([removeFromTeamOrders]: the same compaction per team).
     */
    suspend fun delete(id: UInt, guard: PlanGuard): ProjectDeleteOutcome = database.withPlanWrite { revision ->
        guard(projectChain(id) ?: throw NotFoundException("Project not found"))
        val affected = Projects.update({ (Projects.id eq id) and Projects.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = nowMillis()
        }
        if (affected == 0) throw NotFoundException("Project not found")
        val milestoneIds = activeMilestoneIdsOf(id)
        val dependencies = deleteDependenciesOf(milestoneIds, listOf(id))
        removeFromTeamOrders(milestoneIds)
        val milestoneCount = deleteMilestonesOf(id)
        removeFromRanking(id, revision + 1)
        ProjectDeleteOutcome(milestoneCount, dependencies)
    }.value
}
