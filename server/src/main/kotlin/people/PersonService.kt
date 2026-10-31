package ch.nokillswit.people

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.containsNormalized
import ch.nokillswit.infra.db.lockActiveForWrite
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.paging.PageRequest
import ch.nokillswit.infra.paging.applyPaging
import ch.nokillswit.teams.TeamService
import ch.nokillswit.users.UserService
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val PersonServiceKey = AttributeKey<PersonService>("PersonService")

private val SORTABLE_COLUMNS: Map<String, Column<*>> = mapOf(
    "id" to PersonService.People.id,
    "name" to PersonService.People.name,
    "email" to PersonService.People.email,
    "createdAt" to PersonService.People.createdAt,
    "updatedAt" to PersonService.People.updatedAt,
)

/** The ONE sortable whitelist — derived from the column map so the two can never drift. */
val PERSON_SORT_FIELDS: Set<String> = SORTABLE_COLUMNS.keys

class PersonService(private val database: R2dbcDatabase) {
    object People : UIntIdTable("people"), SoftDeletable {
        // Email and login-link uniqueness ride the partial unique indexes uq_people_email_active and
        // uq_people_user_id_active (V10, active rows only) — Exposed defs are query-only, so no `.uniqueIndex()` here.
        val name = varchar("name", length = MAX_PERSON_NAME_LENGTH)
        val email = varchar("email", length = MAX_PERSON_EMAIL_LENGTH).nullable()

        /** V10: the optional login. May name a soft-deleted user — readers resolve it through ACTIVE users. */
        // The one foreign key from the people table to Users, so the implicit People -> Users join is unambiguous.
        val userId = reference("user_id", UserService.Users).nullable()
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    suspend fun list(filter: PersonListFilter, paging: PageRequest): PersonListResult = suspendTransaction(database) {
        val predicate = buildPredicate(filter) and People.active()
        val total = People.selectAll().where { predicate }.count()
        val rows = People.selectAll().where { predicate }.applyPaging(paging, SORTABLE_COLUMNS).toList()
        val logins = activeUserEmails(rows.mapNotNull { it[People.userId]?.value })
        PersonListResult(
            items = rows.map { row ->
                val linked = row[People.userId]?.value?.takeIf { it in logins }
                PersonListItem(
                    id = row[People.id].value,
                    name = row[People.name],
                    email = row[People.email],
                    userId = linked,
                    userEmail = linked?.let(logins::get),
                    createdAt = row[People.createdAt],
                    updatedAt = row[People.updatedAt],
                )
            },
            total = total,
        )
    }

    /** The person, or null when missing/deleted. */
    suspend fun read(id: UInt): PersonResponse? = suspendTransaction(database) {
        val row = People.selectAll().where { (People.id eq id) and People.active() }.toList().singleOrNull()
            ?: return@suspendTransaction null
        val storedUserId = row[People.userId]?.value
        val userEmail = storedUserId?.let { activeUserEmails(listOf(it))[it] }
        PersonResponse(
            id = id,
            name = row[People.name],
            email = row[People.email],
            userId = storedUserId.takeIf { userEmail != null },
            userEmail = userEmail,
            createdAt = row[People.createdAt],
            updatedAt = row[People.updatedAt],
        )
    }

    /**
     * Creates the person and its optional login link in ONE transaction: an unknown or soft-deleted user id is a 400
     * (client-supplied FK — never a 500 from the constraint). An email clash or a second link to the same user rides the
     * V10 partial indexes into the central 23505 → 409.
     */
    suspend fun create(request: PersonCreateRequest): UInt = suspendTransaction(database) {
        validatePersonCreate(request) // re-checked service-side so direct callers stay guarded
        requireActiveUser(request.userId)
        val stamp = nowMillis()
        People.insert {
            it[name] = request.name
            it[email] = request.email
            it[userId] = request.userId
            it[createdAt] = stamp
            it[updatedAt] = stamp
        }[People.id].value
    }

    /**
     * Name/email/login replace (full replace — an omitted email or userId clears it). `affected` 0 → 404; `userFrom`
     * is the stored link before the write.
     */
    suspend fun update(id: UInt, request: PersonUpdateRequest): PersonUpdateOutcome = suspendTransaction(database) {
        validatePersonUpdate(request)
        // NO KEY UPDATE: serializes with other person writers but not with FK-checking inserts that reference the row
        // (persistence.md "Row locks vs. FK locks").
        val before = People.selectAll().where { (People.id eq id) and People.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
            ?: return@suspendTransaction PersonUpdateOutcome(0, null)
        requireActiveUser(request.userId)
        val affected = People.update({ (People.id eq id) and People.active() }) {
            it[name] = request.name
            it[email] = request.email
            it[userId] = request.userId
            it[updatedAt] = nowMillis()
        }
        PersonUpdateOutcome(affected, before[People.userId]?.value)
    }

    /**
     * The id of the ACTIVE person linked to [userId], or null — the caller's person for the owner-scoped guards.
     * The user-active half of the verdict is the per-request access check, so a deleted login never gets here.
     */
    suspend fun activePersonIdOf(userId: UInt): UInt? = suspendTransaction(database) {
        People.select(People.id)
            .where { (People.userId eq userId) and People.active() }
            .toList()
            .singleOrNull()
            ?.get(People.id)?.value
    }

    /**
     * Soft delete: the person stops reading as active and frees its email and login link. `0` = missing or already
     * deleted (404). A person who still manages an ACTIVE team is a 409 (reassign first); the check runs under the
     * person-row lock, and a concurrent team save locks the person row `FOR SHARE` ([TeamService]), so "count, then delete"
     * cannot interleave with an assignment. C3 extends the check to the plan tables.
     */
    suspend fun delete(id: UInt): Int = suspendTransaction(database) {
        if (!People.lockActiveForWrite(id)) return@suspendTransaction 0
        val managesTeam = TeamService.Teams.select(TeamService.Teams.id)
            .where { (TeamService.Teams.managerPersonId eq id) and TeamService.Teams.active() }
            .count() > 0
        if (managesTeam) throw ConflictException("Person is still an owner or a team manager")
        People.update({ (People.id eq id) and People.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = nowMillis()
        }
    }

    /** One batched lookup: the emails of the ACTIVE users among [ids] (a soft-deleted user is absent). */
    private suspend fun activeUserEmails(ids: Collection<UInt>): Map<UInt, String> {
        if (ids.isEmpty()) return emptyMap()
        return UserService.Users.select(UserService.Users.id, UserService.Users.email)
            .where { (UserService.Users.id inList ids.distinct()) and UserService.Users.active() }
            .map { it[UserService.Users.id].value to it[UserService.Users.email] }
            .toList()
            .toMap()
    }

    /** The login, when set, must be an ACTIVE user — a client-supplied FK is a 400, never a 500 from the constraint. */
    private suspend fun requireActiveUser(userId: UInt?) {
        if (userId == null) return
        val exists = UserService.Users.select(UserService.Users.id)
            .where { (UserService.Users.id eq userId) and UserService.Users.active() }
            .count() > 0
        if (!exists) throw BadRequestException("Unknown or deleted user ids: $userId")
    }

    private fun buildPredicate(filter: PersonListFilter): Op<Boolean> {
        var op: Op<Boolean> = Op.TRUE
        filter.name?.takeIf { it.isNotBlank() }?.let { op = op and People.name.containsNormalized(it) }
        filter.email?.takeIf { it.isNotBlank() }?.let { op = op and People.email.containsNormalized(it) }
        return op
    }
}
