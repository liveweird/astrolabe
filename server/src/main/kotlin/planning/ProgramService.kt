package ch.nokillswit.planning

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.people.PersonService
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val ProgramServiceKey = AttributeKey<ProgramService>("ProgramService")

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

    /** The program's owner chain (work stream first), or null when it or its work stream is missing or deleted. */
    suspend fun chain(id: UInt): OwnerChain? = suspendTransaction(database) { programChain(id) }

    /** The program, or null when missing/deleted. */
    suspend fun read(id: UInt): ProgramResponse? = suspendTransaction(database) {
        val row = Programs.selectAll().where { (Programs.id eq id) and Programs.active() }.toList().singleOrNull()
            ?: return@suspendTransaction null
        val ownerId = row[Programs.ownerPersonId].value
        ProgramResponse(
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
    suspend fun create(workStreamId: UInt, request: ProgramCreateRequest, guard: PlanGuard): UInt {
        validateProgram(request)
        return database.withPlanWrite {
            guard(workStreamChain(workStreamId) ?: throw NotFoundException("Work stream not found"))
            requireActiveOwner(request.ownerPersonId)
            val stamp = nowMillis()
            Programs.insert {
                it[this.workStreamId] = workStreamId
                it[name] = request.name
                it[description] = request.description
                it[ownerPersonId] = request.ownerPersonId
                it[createdAt] = stamp
                it[updatedAt] = stamp
            }[Programs.id].value
        }.value
    }

    /**
     * Full replace under the plan lock (the parent never changes; the chain is re-read and [guard] re-run first, missing = 404);
     * the outcome carries the STORED owner.
     */
    suspend fun update(id: UInt, request: ProgramUpdateRequest, guard: PlanGuard): ProgramUpdateOutcome {
        validateProgram(request)
        return database.withPlanWrite {
            guard(programChain(id) ?: throw NotFoundException("Program not found"))
            val before = Programs.select(Programs.ownerPersonId).where { (Programs.id eq id) and Programs.active() }
                .toList().singleOrNull() ?: throw NotFoundException("Program not found")
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
     * along, the ranking is untouched, and a move to the current work stream writes nothing (the outcome says so).
     */
    suspend fun move(id: UInt, workStreamId: UInt, guards: MoveGuards): MoveOutcome = database.withPlanWrite {
        guards.source(programChain(id) ?: throw NotFoundException("Program not found"))
        guards.target(workStreamChain(workStreamId) ?: unknownMoveTarget("work stream", workStreamId))
        val from = Programs.select(Programs.workStreamId).where { (Programs.id eq id) and Programs.active() }
            .toList().singleOrNull()?.get(Programs.workStreamId)?.value ?: throw NotFoundException("Program not found")
        if (from != workStreamId) {
            Programs.update({ (Programs.id eq id) and Programs.active() }) {
                it[this.workStreamId] = workStreamId
                it[updatedAt] = nowMillis()
            }
        }
        MoveOutcome(from, workStreamId)
    }.value

    /** Soft delete under the plan lock: 409 while the program has ACTIVE projects (counted under the lock, like the work stream). */
    suspend fun delete(id: UInt, guard: PlanGuard) {
        database.withPlanWrite {
            val projects = ProjectService.Projects
            guard(programChain(id) ?: throw NotFoundException("Program not found"))
            val hasProjects = projects.select(projects.id)
                .where { (projects.programId eq id) and projects.active() }.count() > 0
            if (hasProjects) throw ConflictException("Program has active projects")
            Programs.update({ (Programs.id eq id) and Programs.active() }) {
                it[markedAsDeleted] = true
                it[updatedAt] = nowMillis()
            }
        }
    }
}
