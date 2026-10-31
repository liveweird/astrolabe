package ch.nokillswit.planning

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.localDate
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.people.PersonService
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val WorkStreamServiceKey = AttributeKey<WorkStreamService>("WorkStreamService")

/**
 * Work streams (V12). Every write runs under the `plan_state` lock ([withPlanWrite]) and bumps the plan revision; a missing or
 * deleted target found under the lock throws the 404 so the whole transaction rolls back and the revision stays put. Name
 * uniqueness rides `uq_work_streams_name_active` (partial, case-insensitive) into the central 23505 -> 409.
 */
class WorkStreamService(private val database: R2dbcDatabase) {
    object WorkStreams : UIntIdTable("work_streams"), SoftDeletable {
        val name = varchar("name", length = MAX_PLAN_NAME_LENGTH)
        val description = varchar("description", length = MAX_PLAN_DESCRIPTION_LENGTH).nullable()

        /** Required; always an ACTIVE person while the stream is active (the owner check on every write, the person-delete 409). */
        val ownerPersonId = reference("owner_person_id", PersonService.People)
        val startDate = localDate("start_date")

        /** Set only when the stream is closed. */
        val endDate = localDate("end_date").nullable()
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    /** The stream's owner chain, or null when it is missing or deleted (the route's 404, before the guard). */
    suspend fun chain(id: UInt): OwnerChain? = suspendTransaction(database) { workStreamChain(id) }

    /** The work stream, or null when missing/deleted. */
    suspend fun read(id: UInt): WorkStreamResponse? = suspendTransaction(database) {
        val row = WorkStreams.selectAll().where { (WorkStreams.id eq id) and WorkStreams.active() }.toList().singleOrNull()
            ?: return@suspendTransaction null
        val names = ownerNames(listOf(row[WorkStreams.ownerPersonId].value))
        WorkStreamResponse(
            id = id,
            name = row[WorkStreams.name],
            description = row[WorkStreams.description],
            ownerPersonId = row[WorkStreams.ownerPersonId].value,
            ownerName = names.getValue(row[WorkStreams.ownerPersonId].value),
            startDate = row[WorkStreams.startDate].toString(),
            endDate = row[WorkStreams.endDate]?.toString(),
            createdAt = row[WorkStreams.createdAt],
            updatedAt = row[WorkStreams.updatedAt],
        )
    }

    /** Creates the stream under the plan lock; an inactive owner is a 400, a name clash a 409. */
    suspend fun create(request: WorkStreamCreateRequest): UInt {
        val dates = validateWorkStream(request) // re-checked service-side so direct callers stay guarded
        return database.withPlanWrite {
            requireActiveOwner(request.ownerPersonId)
            val stamp = nowMillis()
            WorkStreams.insert {
                it[name] = request.name
                it[description] = request.description
                it[ownerPersonId] = request.ownerPersonId
                it[startDate] = dates.start
                it[endDate] = dates.end
                it[createdAt] = stamp
                it[updatedAt] = stamp
            }[WorkStreams.id].value
        }.value
    }

    /**
     * Full replace under the plan lock. Under the lock the chain is re-read (missing = 404) and [guard] re-run against it. The
     * outcome carries the STORED owner and end date for the audit.
     */
    suspend fun update(id: UInt, request: WorkStreamUpdateRequest, guard: PlanGuard): WorkStreamUpdateOutcome {
        val dates = validateWorkStream(request)
        return database.withPlanWrite {
            guard(workStreamChain(id) ?: throw NotFoundException("Work stream not found"))
            val before = WorkStreams.selectAll().where { (WorkStreams.id eq id) and WorkStreams.active() }
                .toList().singleOrNull() ?: throw NotFoundException("Work stream not found")
            requireActiveOwner(request.ownerPersonId)
            WorkStreams.update({ (WorkStreams.id eq id) and WorkStreams.active() }) {
                it[name] = request.name
                it[description] = request.description
                it[ownerPersonId] = request.ownerPersonId
                it[startDate] = dates.start
                it[endDate] = dates.end
                it[updatedAt] = nowMillis()
            }
            WorkStreamUpdateOutcome(before[WorkStreams.ownerPersonId].value, before[WorkStreams.endDate])
        }.value
    }

    /**
     * Soft delete under the plan lock: 409 while the stream has ACTIVE programs. The count runs under the lock, which is what makes
     * "count the children, then delete" race-free against a concurrent program create (a child INSERT's FK check takes only
     * `FOR KEY SHARE`, which a row lock on the stream would not block; `persistence.md` "Row locks vs. FK locks"). A missing
     * stream is a 404.
     */
    suspend fun delete(id: UInt, guard: PlanGuard) {
        database.withPlanWrite {
            val programs = ProgramService.Programs
            guard(workStreamChain(id) ?: throw NotFoundException("Work stream not found"))
            val hasPrograms = programs.select(programs.id)
                .where { (programs.workStreamId eq id) and programs.active() }.count() > 0
            if (hasPrograms) throw ConflictException("Work stream has active programs")
            WorkStreams.update({ (WorkStreams.id eq id) and WorkStreams.active() }) {
                it[markedAsDeleted] = true
                it[updatedAt] = nowMillis()
            }
        }
    }
}
