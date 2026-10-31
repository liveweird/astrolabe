package ch.nokillswit.teams

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.infra.db.containsNormalized
import ch.nokillswit.infra.paging.PageRequest
import ch.nokillswit.infra.paging.applyPaging
import ch.nokillswit.people.PersonService
import ch.nokillswit.planning.hasActiveMilestones
import ch.nokillswit.users.UserService
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.db.lockActiveForWrite
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val TeamServiceKey = AttributeKey<TeamService>("TeamService")

private val SORTABLE_COLUMNS: Map<String, Column<*>> = mapOf(
    "id" to TeamService.Teams.id,
    "name" to TeamService.Teams.name,
    "createdAt" to TeamService.Teams.createdAt,
    "updatedAt" to TeamService.Teams.updatedAt,
)

/** The ONE sortable whitelist — derived from the column map so the two can never drift. */
val TEAM_SORT_FIELDS: Set<String> = SORTABLE_COLUMNS.keys

class TeamService(private val database: R2dbcDatabase) {
    object Teams : UIntIdTable("teams"), SoftDeletable {
        // Case-folded name uniqueness rides the partial unique index uq_teams_name_active
        // (V6, active rows only) — Exposed defs are query-only, so no `.uniqueIndex()` here.
        val name = varchar("name", length = MAX_TEAM_NAME_LENGTH)
        val description = varchar("description", length = MAX_TEAM_DESCRIPTION_LENGTH).nullable()

        /** V10: the optional manager, a person (V6 held a user). May name a soft-deleted person; readers resolve it via ACTIVE people. */
        // The one foreign key from the team tables to People (no roster table), so the implicit Teams -> People join is unambiguous.
        val managerPersonId = reference("manager_person_id", PersonService.People).nullable()
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    suspend fun list(filter: TeamListFilter, paging: PageRequest): TeamListResult = suspendTransaction(database) {
        val predicate = buildPredicate(filter) and Teams.active()
        val total = Teams.selectAll().where { predicate }.count()
        val rows = Teams.selectAll().where { predicate }.applyPaging(paging, SORTABLE_COLUMNS).toList()
        val managers = activePersonNames(rows.mapNotNull { it[Teams.managerPersonId]?.value })
        TeamListResult(
            items = rows.map { row ->
                val id = row[Teams.id].value
                val managerId = row[Teams.managerPersonId]?.value?.takeIf { it in managers }
                TeamListItem(
                    id = id,
                    name = row[Teams.name],
                    description = row[Teams.description],
                    managerPersonId = managerId,
                    managerName = managerId?.let(managers::get),
                    createdAt = row[Teams.createdAt],
                    updatedAt = row[Teams.updatedAt],
                )
            },
            total = total,
        )
    }

    /** The team, or null when missing/deleted. */
    suspend fun read(id: UInt): TeamResponse? = suspendTransaction(database) {
        val row = Teams.selectAll().where { (Teams.id eq id) and Teams.active() }.toList().singleOrNull()
            ?: return@suspendTransaction null
        val managerId = row[Teams.managerPersonId]?.value
        val managerName = managerId?.let { activePersonNames(listOf(it))[it] }
        TeamResponse(
            id = id,
            name = row[Teams.name],
            description = row[Teams.description],
            managerPersonId = managerId.takeIf { managerName != null },
            managerName = managerName,
            createdAt = row[Teams.createdAt],
            updatedAt = row[Teams.updatedAt],
        )
    }

    /**
     * Creates the team and its optional manager in ONE transaction: an unknown or soft-deleted manager id is a 400
     * (client-supplied FK — never a 500 from the constraint). A name clash with an active team rides the V6 partial
     * index into the central 23505 → 409.
     */
    suspend fun create(request: TeamCreateRequest): UInt = suspendTransaction(database) {
        validateTeamCreate(request) // re-checked service-side so direct callers stay guarded
        requireActiveManager(request.managerPersonId)
        val stamp = nowMillis()
        Teams.insert {
            it[name] = request.name
            it[description] = request.description
            it[managerPersonId] = request.managerPersonId
            it[createdAt] = stamp
            it[updatedAt] = stamp
        }[Teams.id].value
    }

    /**
     * Name/description/manager replace (full replace — an omitted manager clears it). `affected` 0 → 404;
     * `managerFrom` is the stored manager before the write.
     */
    suspend fun update(id: UInt, request: TeamUpdateRequest): TeamUpdateOutcome = suspendTransaction(database) {
        validateTeamUpdate(request)
        // NO KEY UPDATE: serializes with other team writers but not with FK-checking inserts that reference the row (persistence.md
        // "Row locks vs. FK locks").
        val before = Teams.selectAll().where { (Teams.id eq id) and Teams.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
            ?: return@suspendTransaction TeamUpdateOutcome(0, null)
        requireActiveManager(request.managerPersonId)
        val affected = Teams.update({ (Teams.id eq id) and Teams.active() }) {
            it[name] = request.name
            it[description] = request.description
            it[managerPersonId] = request.managerPersonId
            it[updatedAt] = nowMillis()
        }
        TeamUpdateOutcome(affected, before[Teams.managerPersonId]?.value)
    }

    /**
     * Whether [userId] is the team's current manager: an ACTIVE team whose manager is an ACTIVE person linked to this
     * ACTIVE user — one query. False for a missing/deleted team too, so `requireTeamManagerOrAdmin` answers a uniform 403.
     * The user-active predicate is the second line behind the per-request access check (`TokenBlocklistService.accessVerdict`).
     */
    suspend fun isActiveManager(teamId: UInt, userId: UInt): Boolean = suspendTransaction(database) {
        val people = PersonService.People
        Teams.innerJoin(people, { managerPersonId }, { people.id })
            .innerJoin(UserService.Users, { people.userId }, { UserService.Users.id })
            .select(Teams.id)
            .where {
                (Teams.id eq teamId) and Teams.active() and people.active() and
                    (people.userId eq userId) and UserService.Users.active()
            }
            .count() > 0
    }

    /**
     * [isActiveManager] for a write that runs INSIDE a plan-locked transaction (the milestone schedule PUT): the same join, but the TEAM
     * row and the manager's PERSON row are locked `FOR SHARE` (`FOR SHARE OF teams, people`), so a manager change ([update], `FOR NO KEY
     * UPDATE` on the team), a re-link or delete of the manager's person (`PersonService.update`/`delete`, `FOR NO KEY UPDATE`) either
     * commits first (this answers false) or waits for the write. The USER row is deliberately not locked: `PasswordResetService.lockUser`
     * and the users writers take `FOR UPDATE`/`FOR NO KEY UPDATE` there and must not queue behind a drag; the access check already
     * refuses a deleted login's token. Nests into the caller's transaction.
     */
    suspend fun lockedIsActiveManager(teamId: UInt, userId: UInt): Boolean = suspendTransaction(database) {
        val people = PersonService.People
        Teams.innerJoin(people, { managerPersonId }, { people.id })
            .innerJoin(UserService.Users, { people.userId }, { UserService.Users.id })
            .select(Teams.id)
            .where {
                (Teams.id eq teamId) and Teams.active() and people.active() and
                    (people.userId eq userId) and UserService.Users.active()
            }
            .forUpdate(ForUpdateOption.PostgreSQL.ForShare(null, Teams, people))
            .toList() // not count(): FOR SHARE is refused with an aggregate
            .isNotEmpty()
    }

    /**
     * Soft delete: the team stops reading as active and frees its name. `0` = missing or already deleted (404). A team that an ACTIVE
     * milestone names is a 409 (move or delete the milestones first): the count runs under the team row lock, and a milestone write locks
     * the team row `FOR SHARE` (`MilestoneService.requireActiveTeam`), so "count, then delete" cannot interleave with an assignment.
     */
    suspend fun delete(id: UInt): Int = suspendTransaction(database) {
        if (!Teams.lockActiveForWrite(id)) return@suspendTransaction 0
        if (hasActiveMilestones(id)) throw ConflictException("Team still has milestones")
        Teams.update({ (Teams.id eq id) and Teams.active() }) {
            it[markedAsDeleted] = true
            it[updatedAt] = nowMillis()
        }
    }

    /** One batched lookup: the display names of the ACTIVE people among [ids] (a soft-deleted person is absent). */
    private suspend fun activePersonNames(ids: Collection<UInt>): Map<UInt, String> {
        if (ids.isEmpty()) return emptyMap()
        val people = PersonService.People
        return people.select(people.id, people.name)
            .where { (people.id inList ids.distinct()) and people.active() }
            .map { it[people.id].value to it[people.name] }
            .toList()
            .toMap()
    }

    /**
     * The manager, when set, must be an ACTIVE person — a client-supplied FK is a 400, never a 500 from the constraint.
     * The check locks the person row `FOR SHARE`, which conflicts with `PersonService.delete`'s `FOR NO KEY UPDATE`: a
     * delete racing this assignment either commits first (the person reads inactive here, 400) or waits for this
     * transaction and then sees the team (409) — never an active team left pointing at a deleted person.
     */
    private suspend fun requireActiveManager(personId: UInt?) {
        if (personId == null) return
        val people = PersonService.People
        val exists = people.select(people.id)
            .where { (people.id eq personId) and people.active() }
            .forUpdate(ForUpdateOption.PostgreSQL.ForShare)
            .toList()
            .isNotEmpty()
        if (!exists) throw BadRequestException("Unknown or deleted manager ids: $personId")
    }

    private fun buildPredicate(filter: TeamListFilter): Op<Boolean> {
        var op: Op<Boolean> = Op.TRUE
        filter.name?.takeIf { it.isNotBlank() }?.let { op = op and Teams.name.containsNormalized(it) }
        return op
    }
}
