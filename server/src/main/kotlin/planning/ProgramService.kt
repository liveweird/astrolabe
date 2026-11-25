package ch.nokillswit.planning

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.containsNormalized
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.paging.PageRequest
import ch.nokillswit.infra.paging.applyPaging
import ch.nokillswit.infra.paging.pagedRead
import ch.nokillswit.people.PersonService
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val ProgramServiceKey = AttributeKey<ProgramService>("ProgramService")

private val SORTABLE_COLUMNS: Map<String, Column<*>> = mapOf(
    "id" to ProgramService.Programs.id,
    "name" to ProgramService.Programs.name,
    "createdAt" to ProgramService.Programs.createdAt,
    "updatedAt" to ProgramService.Programs.updatedAt,
)

/** The ONE sortable whitelist of `GET /programs`, derived from the column map so the two can never drift. */
val PROGRAM_SORT_FIELDS: Set<String> = SORTABLE_COLUMNS.keys

/**
 * Programs (V12), under one work stream. Same protocol as [WorkStreamService]: every write under the `plan_state` lock, the
 * parent re-checked under the lock (a stream deleted between the route's chain read and the write is a 404, nothing written), the
 * owner an ACTIVE person (400), the name unique among active programs globally (`uq_programs_name_active`, 409).
 */
class ProgramService(private val database: R2dbcDatabase) {
    object Programs : UIntIdTable("programs"), SoftDeletable {
        val workStreamId = reference("work_stream_id", WorkStreamService.WorkStreams)
        val name = varchar("name", length = MAX_PLAN_NAME_LENGTH)
        val description = varchar("description", length = MAX_PLAN_DESCRIPTION_LENGTH).nullable()

        /** Required; always an ACTIVE person while the program is active. */
        val ownerPersonId = reference("owner_person_id", PersonService.People)
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    /**
     * The paged program list (the bind dialog's picker): ACTIVE programs under an ACTIVE work stream, one predicate for the count and
     * the rows in ONE read transaction (no lock, no revision). The work stream's name rides the join; an unknown `workStreamId`
     * matches nothing (an empty page).
     */
    suspend fun list(filter: ProgramListFilter, paging: PageRequest): ProgramListResult = pagedRead(database) {
        val streams = WorkStreamService.WorkStreams
        var predicate: Op<Boolean> = Programs.active() and streams.active()
        filter.name?.takeIf { it.isNotBlank() }?.let { predicate = predicate and Programs.name.containsNormalized(it) }
        filter.workStreamId?.let { predicate = predicate and (Programs.workStreamId eq it) }
        val joined = Programs.innerJoin(streams, { Programs.workStreamId }, { streams.id })
        val total = joined.selectAll().where { predicate }.count()
        val rows = joined.select(Programs.columns + streams.name)
            .where { predicate }
            .applyPaging(paging, SORTABLE_COLUMNS)
            .toList()
        val owners = ownerNames(rows.map { it[Programs.ownerPersonId].value })
        ProgramListResult(
            items = rows.map { row ->
                val ownerId = row[Programs.ownerPersonId].value
                ProgramListItem(
                    id = row[Programs.id].value,
                    workStreamId = row[Programs.workStreamId].value,
                    name = row[Programs.name],
                    description = row[Programs.description],
                    ownerPersonId = ownerId,
                    ownerName = owners.getValue(ownerId),
                    workStreamName = row[streams.name],
                    createdAt = row[Programs.createdAt],
                    updatedAt = row[Programs.updatedAt],
                )
            },
            total = total,
        )
    }

    /** The program's owner chain (work stream first), or null when it or its work stream is missing or deleted. */
    suspend fun chain(id: UInt): OwnerChain? = suspendTransaction(database) { programChain(id) }

    /** The program, or null when missing/deleted. */
    suspend fun read(id: UInt): ProgramResponse? = suspendTransaction(database) {
        responseInTransaction(id)
    }

    private suspend fun responseInTransaction(id: UInt): ProgramResponse? {
        val row = Programs.selectAll().where { (Programs.id eq id) and Programs.active() }.toList().singleOrNull()
            ?: return null
        val ownerId = row[Programs.ownerPersonId].value
        return ProgramResponse(
            id = id,
            workStreamId = row[Programs.workStreamId].value,
            name = row[Programs.name],
            description = row[Programs.description],
            ownerPersonId = ownerId,
            ownerName = ownerNames(listOf(ownerId)).getValue(ownerId),
            createdAt = row[Programs.createdAt],
            updatedAt = row[Programs.updatedAt],
        )
    }

    /**
     * Creates a program under [workStreamId]; under the lock the stream's chain is re-read (missing = 404) and [guard] re-run,
     * then an inactive owner is a 400 and a name clash a 409.
     */
    suspend fun create(workStreamId: UInt, request: ProgramCreateRequest, guard: PlanGuard): UInt =
        createResult(workStreamId, request, guard) { it }

    internal suspend fun createResponse(
        workStreamId: UInt,
        request: ProgramCreateRequest,
        guard: PlanGuard,
    ): ProgramResponse = createResult(workStreamId, request, guard) { id ->
        checkNotNull(responseInTransaction(id)) { "the program just inserted is readable" }
    }

    private suspend fun <T> createResult(
        workStreamId: UInt,
        request: ProgramCreateRequest,
        guard: PlanGuard,
        result: suspend (UInt) -> T,
    ): T {
        validateProgram(request)
        return database.withPlanWrite {
            guard(workStreamChain(workStreamId).orNotFound("Work stream"))
            requireActiveOwner(request.ownerPersonId)
            val stamp = nowMillis()
            val id = insertProgramRow(workStreamId, request.name, request.description, request.ownerPersonId, stamp)
            result(id)
        }.value
    }

    /**
     * Full replace under the plan lock (the parent never changes; the chain is re-read and [guard] re-run first, missing = 404);
     * the outcome carries the STORED owner.
     */
    suspend fun update(id: UInt, request: ProgramUpdateRequest, guard: PlanGuard): ProgramUpdateOutcome {
        validateProgram(request)
        return database.withPlanWrite {
            guard(programChain(id).orNotFound("Program"))
            val before = Programs.select(Programs.ownerPersonId).where { (Programs.id eq id) and Programs.active() }
                .toList().singleOrNull().orNotFound("Program")
            requireActiveOwner(request.ownerPersonId)
            Programs.update({ (Programs.id eq id) and Programs.active() }) {
                it[name] = request.name
                it[description] = request.description
                it[ownerPersonId] = request.ownerPersonId
                it[updatedAt] = nowMillis()
            }
            ProgramUpdateOutcome(before[Programs.ownerPersonId].value)
        }.value
    }

    /**
     * Moves the program under [workStreamId] under the plan lock. The SOURCE chain is re-read (missing = 404) and the source guard
     * re-run on it (the work stream's owner), then the TARGET work stream's chain (missing = 400, a body field) and the target guard
     * on that too: both must pass. Program names are globally unique, so a move cannot clash; its projects (and their milestones) ride
     * along, the ranking is untouched, the program leaves its old stream's program order (V34), and a move to the current work stream
     * writes nothing (the outcome says so).
     */
    suspend fun move(id: UInt, workStreamId: UInt, guards: MoveGuards): MoveOutcome = database.withPlanWrite {
        guards.source(programChain(id).orNotFound("Program"))
        guards.target(workStreamChain(workStreamId) ?: unknownMoveTarget("work stream", workStreamId))
        val from = Programs.select(Programs.workStreamId).where { (Programs.id eq id) and Programs.active() }
            .toList().singleOrNull()?.get(Programs.workStreamId)?.value.orNotFound("Program")
        if (from != workStreamId) {
            Programs.update({ (Programs.id eq id) and Programs.active() }) {
                it[this.workStreamId] = workStreamId
                it[updatedAt] = nowMillis()
            }
            // The program leaves the source stream's order (the gap closes) and is unlisted in the target (V34).
            removeFromProgramOrder(id)
        }
        MoveOutcome(from, workStreamId)
    }.value

    /** Soft delete under the plan lock: 409 while the program has ACTIVE projects (counted under the lock, like the work stream). */
    suspend fun delete(id: UInt, guard: PlanGuard) {
        database.withPlanWrite {
            val projects = ProjectService.Projects
            guard(programChain(id).orNotFound("Program"))
            val hasProjects = projects.select(projects.id)
                .where { (projects.programId eq id) and projects.active() }.count() > 0
            if (hasProjects) throw ConflictException("Program has active projects")
            Programs.update({ (Programs.id eq id) and Programs.active() }) {
                it[markedAsDeleted] = true
                it[updatedAt] = nowMillis()
            }
            removeFromProgramOrder(id) // the program leaves its stream's order in the same transaction (V34)
        }
    }
}
