package ch.nokillswit.planning

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.OwnerChain
import ch.nokillswit.authz.orNotFound
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.containsNormalized
import ch.nokillswit.infra.db.localDate
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

val WorkStreamServiceKey = AttributeKey<WorkStreamService>("WorkStreamService")

private val SORTABLE_COLUMNS: Map<String, Column<*>> = mapOf(
    "id" to WorkStreamService.WorkStreams.id,
    "name" to WorkStreamService.WorkStreams.name,
    "startDate" to WorkStreamService.WorkStreams.startDate,
    "createdAt" to WorkStreamService.WorkStreams.createdAt,
    "updatedAt" to WorkStreamService.WorkStreams.updatedAt,
)

/** The ONE sortable whitelist of `GET /work-streams`, derived from the column map so the two can never drift. */
val WORK_STREAM_SORT_FIELDS: Set<String> = SORTABLE_COLUMNS.keys

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

    /**
     * The paged work stream list: ACTIVE streams, one predicate for the count and the rows in ONE read transaction (no lock, no
     * revision: a list is not a plan view).
     */
    suspend fun list(filter: WorkStreamListFilter, paging: PageRequest): WorkStreamListResult = pagedRead(database) {
        var predicate: Op<Boolean> = WorkStreams.active()
        filter.name?.takeIf { it.isNotBlank() }?.let { predicate = predicate and WorkStreams.name.containsNormalized(it) }
        val total = WorkStreams.selectAll().where { predicate }.count()
        val rows = WorkStreams.selectAll().where { predicate }.applyPaging(paging, SORTABLE_COLUMNS).toList()
        val owners = ownerNames(rows.map { it[WorkStreams.ownerPersonId].value })
        WorkStreamListResult(
            items = rows.map { row ->
                val ownerId = row[WorkStreams.ownerPersonId].value
                WorkStreamResponse(
                    id = row[WorkStreams.id].value,
                    name = row[WorkStreams.name],
                    description = row[WorkStreams.description],
                    ownerPersonId = ownerId,
                    ownerName = owners.getValue(ownerId),
                    startDate = row[WorkStreams.startDate].toString(),
                    endDate = row[WorkStreams.endDate]?.toString(),
                    createdAt = row[WorkStreams.createdAt],
                    updatedAt = row[WorkStreams.updatedAt],
                )
            },
            total = total,
        )
    }

    /** The stream's owner chain, or null when it is missing or deleted (the route's 404, before the guard). */
    suspend fun chain(id: UInt): OwnerChain? = suspendTransaction(database) { workStreamChain(id) }

    /** The work stream, or null when missing/deleted. */
    suspend fun read(id: UInt): WorkStreamResponse? = suspendTransaction(database) {
        responseInTransaction(id)
    }

    private suspend fun responseInTransaction(id: UInt): WorkStreamResponse? {
        val row = WorkStreams.selectAll().where { (WorkStreams.id eq id) and WorkStreams.active() }.toList().singleOrNull()
            ?: return null
        val names = ownerNames(listOf(row[WorkStreams.ownerPersonId].value))
        return WorkStreamResponse(
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
    suspend fun create(request: WorkStreamCreateRequest): UInt = createResult(request) { it }

    internal suspend fun createResponse(request: WorkStreamCreateRequest): WorkStreamResponse =
        createResult(request) { id -> checkNotNull(responseInTransaction(id)) { "the work stream just inserted is readable" } }

    private suspend fun <T> createResult(request: WorkStreamCreateRequest, result: suspend (UInt) -> T): T {
        val dates = validateWorkStream(request) // re-checked service-side so direct callers stay guarded
        return database.withPlanWrite {
            requireActiveOwner(request.ownerPersonId)
            val stamp = nowMillis()
            val id = WorkStreams.insert {
                it[name] = request.name
                it[description] = request.description
                it[ownerPersonId] = request.ownerPersonId
                it[startDate] = dates.start
                it[endDate] = dates.end
                it[createdAt] = stamp
                it[updatedAt] = stamp
            }[WorkStreams.id].value
            result(id)
        }.value
    }

    /**
     * Full replace under the plan lock. Under the lock the chain is re-read (missing = 404) and [guard] re-run against it. The
     * outcome carries the STORED owner and end date for the audit.
     */
    suspend fun update(id: UInt, request: WorkStreamUpdateRequest, guard: PlanGuard): WorkStreamUpdateOutcome {
        val dates = validateWorkStream(request)
        return database.withPlanWrite {
            guard(workStreamChain(id).orNotFound("Work stream"))
            val before = WorkStreams.selectAll().where { (WorkStreams.id eq id) and WorkStreams.active() }
                .toList().singleOrNull().orNotFound("Work stream")
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
            guard(workStreamChain(id).orNotFound("Work stream"))
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
