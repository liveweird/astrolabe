package ch.nokillswit.flow

import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.insertRows
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val FlowMirrorStoreKey = AttributeKey<FlowMirrorStore>("FlowMirrorStore")

/** What [FlowMirrorStore.replace] did: [WRITTEN], or nothing because the connection was deleted ([GONE]) or switched off ([DISABLED]). */
enum class FlowMirrorWrite { WRITTEN, GONE, DISABLED }

/**
 * `flow_teams` (V24): the teams of the latest Flow document of a connection. Not plan state: no soft delete, no revision, no plan lock.
 * With [FlowSprints] and [FlowMembers] it is replaced wholesale by every run and hard-deleted with its connection - a documented
 * hard-delete exception beside `jira_issues` (`persistence.md` "Soft delete").
 */
object FlowTeams : Table("flow_teams") {
    val connectionId = reference("connection_id", FlowConnectionService.Connections)
    val flowTeamId = integer("flow_team_id")
    val name = varchar("name", length = FLOW_TEAM_NAME_WIDTH)
    val defaultCapacityMd = decimal("default_capacity_md", 8, 2).nullable()
    val observedAt = long("observed_at")
    override val primaryKey = PrimaryKey(connectionId, flowTeamId)
}

/** `flow_sprints` (V24): a team's sprints of the latest document, instants raw (the connection's zone applies at read time). */
object FlowSprints : Table("flow_sprints") {
    val connectionId = reference("connection_id", FlowConnectionService.Connections)
    val flowTeamId = integer("flow_team_id")
    val sprintId = long("sprint_id")
    val sourceConnectionId = integer("source_connection_id")
    val name = varchar("name", length = FLOW_SPRINT_NAME_WIDTH)
    val state = varchar("state", length = FLOW_SPRINT_STATE_WIDTH)
    val startAt = long("start_at").nullable()
    val endAt = long("end_at").nullable()
    val completeAt = long("complete_at").nullable()
    val hasCalendar = bool("has_calendar")
    val capacityMd = decimal("capacity_md", 10, 2).nullable()
    val capacitySource = varchar("capacity_source", length = FLOW_CAPACITY_SOURCE_WIDTH).nullable()
    override val primaryKey = PrimaryKey(connectionId, flowTeamId, sprintId)
}

/** `flow_members` (V24): a team's dated Jira-account memberships of the latest document. The account id is never returned by an API. */
object FlowMembers : Table("flow_members") {
    val connectionId = reference("connection_id", FlowConnectionService.Connections)
    val flowTeamId = integer("flow_team_id")
    val accountId = varchar("account_id", length = FLOW_ACCOUNT_ID_WIDTH)
    val displayName = varchar("display_name", length = FLOW_DISPLAY_NAME_WIDTH).nullable()
    val validFrom = long("valid_from")
    val validTo = long("valid_to").nullable()
    override val primaryKey = PrimaryKey(connectionId, flowTeamId, accountId, validFrom)
}

/**
 * The mirror's database side, the ONLY writer of the three tables and of `flow_connections.teams_at`: short transactions, none taking the
 * plan lock, none bumping a revision, none spanning an outbound call (the document is fetched and decoded BEFORE [replace]). A write
 * re-checks that its connection is still ACTIVE under a `FOR NO KEY UPDATE` row lock (the write stamps `teams_at` on that row, so the
 * lock is taken at its final strength: a `FOR SHARE` upgraded by the UPDATE is deadlock-prone), so a delete that raced a run either
 * waits for the write and then removes it, or has won and the write is skipped: no row outlives its connection.
 */
class FlowMirrorStore(private val database: R2dbcDatabase) {
    private val connections = FlowConnectionService.Connections

    /**
     * Replaces the connection's mirror with [teams] in ONE transaction (the old rows deleted, the new ones inserted, `teams_at` stamped
     * with [at]): a failure leaves the previous document intact, and no reader sees a half-written one. The rows are fitted to the
     * columns first ([fitted]). Judged under the connection row lock: [FlowMirrorWrite.GONE] when it is no longer active (deleted since the
     * run started) and [FlowMirrorWrite.DISABLED] when an administrator switched it off meanwhile - both write nothing.
     *
     * [keepAbsentTeams] is the run's rule for a TRUNCATED document (`teamsTruncated`: Flow cut its answer at the team cap, so a team
     * missing from it was merely not sent): the teams of [teams] are replaced and every other team already mirrored is KEPT with its
     * sprints and members (so a bound team never reads as gone because of a cap). Without it the mirror is exactly [teams].
     *
     * The row lock is `FOR NO KEY UPDATE` from the start (never upgraded from `FOR SHARE`): concurrent replaces of one connection, the
     * delete and an edit all queue on it, so there is no lock cycle whatever the run claim allows. It does not conflict with the
     * `FOR KEY SHARE` of an FK check (a binding insert), so a link is never stalled by a replace.
     */
    suspend fun replace(connectionId: UInt, teams: List<FlowMirrorTeam>, at: Long, keepAbsentTeams: Boolean = false): FlowMirrorWrite {
        val rows = teams.distinctBy { it.flowTeamId }.map { it.fitted() }
        return suspendTransaction(database) {
            val row = connections.select(connections.id, connections.enabled)
                .where { (connections.id eq connectionId) and connections.active() }
                .forUpdate(ForUpdateOption.PostgreSQL.ForNoKeyUpdate).toList().singleOrNull()
            if (row == null) return@suspendTransaction FlowMirrorWrite.GONE
            if (!row[connections.enabled]) return@suspendTransaction FlowMirrorWrite.DISABLED
            deleteRowsOf(connectionId, only = if (keepAbsentTeams) rows.map { it.flowTeamId } else null)
            FlowTeams.insertRows(rows) { team ->
                this[FlowTeams.connectionId] = connectionId
                this[FlowTeams.flowTeamId] = team.flowTeamId
                this[FlowTeams.name] = team.name
                this[FlowTeams.defaultCapacityMd] = team.defaultCapacityMd
                this[FlowTeams.observedAt] = at
            }
            FlowSprints.insertRows(rows.flatMap { team -> team.sprints.map { team.flowTeamId to it } }) { (teamId, sprint) ->
                this[FlowSprints.connectionId] = connectionId
                this[FlowSprints.flowTeamId] = teamId
                this[FlowSprints.sprintId] = sprint.sprintId
                this[FlowSprints.sourceConnectionId] = sprint.sourceConnectionId
                this[FlowSprints.name] = sprint.name
                this[FlowSprints.state] = sprint.state
                this[FlowSprints.startAt] = sprint.startAt
                this[FlowSprints.endAt] = sprint.endAt
                this[FlowSprints.completeAt] = sprint.completeAt
                this[FlowSprints.hasCalendar] = sprint.hasCalendar
                this[FlowSprints.capacityMd] = sprint.capacityMd
                this[FlowSprints.capacitySource] = sprint.capacitySource
            }
            FlowMembers.insertRows(rows.flatMap { team -> team.members.map { team.flowTeamId to it } }) { (teamId, member) ->
                this[FlowMembers.connectionId] = connectionId
                this[FlowMembers.flowTeamId] = teamId
                this[FlowMembers.accountId] = member.accountId
                this[FlowMembers.displayName] = member.displayName
                this[FlowMembers.validFrom] = member.validFrom
                this[FlowMembers.validTo] = member.validTo
            }
            connections.update({ connections.id eq connectionId }) { it[teamsAt] = at }
            FlowMirrorWrite.WRITTEN
        }
    }

    /** The connection's mirrored teams by name with their sprint and member counts (≤ ~100 teams); empty before the first run. */
    suspend fun teamsOf(connectionId: UInt): List<FlowMirrorTeamRow> = suspendTransaction(database) {
        val sprintCounts = FlowSprints.select(FlowSprints.flowTeamId, FlowSprints.sprintId.count())
            .where { FlowSprints.connectionId eq connectionId }.groupBy(FlowSprints.flowTeamId).toList()
            .associate { it[FlowSprints.flowTeamId] to it[FlowSprints.sprintId.count()].toInt() }
        val memberCounts = FlowMembers.select(FlowMembers.flowTeamId, FlowMembers.validFrom.count())
            .where { FlowMembers.connectionId eq connectionId }.groupBy(FlowMembers.flowTeamId).toList()
            .associate { it[FlowMembers.flowTeamId] to it[FlowMembers.validFrom.count()].toInt() }
        FlowTeams.selectAll().where { FlowTeams.connectionId eq connectionId }
            .orderBy(FlowTeams.name to SortOrder.ASC, FlowTeams.flowTeamId to SortOrder.ASC).toList().map {
                val id = it[FlowTeams.flowTeamId]
                FlowMirrorTeamRow(
                    flowTeamId = id,
                    name = it[FlowTeams.name],
                    defaultCapacityMd = it[FlowTeams.defaultCapacityMd],
                    observedAt = it[FlowTeams.observedAt],
                    sprintCount = sprintCounts[id] ?: 0,
                    memberCount = memberCounts[id] ?: 0,
                )
            }
    }

    /** A team's sprints by start (undated last, then by id) - the capacity import's input; empty for an unknown team. */
    suspend fun sprintsOf(connectionId: UInt, flowTeamId: Int): List<FlowMirrorSprint> = suspendTransaction(database) {
        FlowSprints.selectAll().where { (FlowSprints.connectionId eq connectionId) and (FlowSprints.flowTeamId eq flowTeamId) }
            .orderBy(FlowSprints.startAt to SortOrder.ASC_NULLS_LAST, FlowSprints.sprintId to SortOrder.ASC).toList().map {
                FlowMirrorSprint(
                    sprintId = it[FlowSprints.sprintId],
                    sourceConnectionId = it[FlowSprints.sourceConnectionId],
                    name = it[FlowSprints.name],
                    state = it[FlowSprints.state],
                    startAt = it[FlowSprints.startAt],
                    endAt = it[FlowSprints.endAt],
                    completeAt = it[FlowSprints.completeAt],
                    hasCalendar = it[FlowSprints.hasCalendar],
                    capacityMd = it[FlowSprints.capacityMd],
                    capacitySource = it[FlowSprints.capacitySource],
                )
            }
    }

    /** A team's membership intervals by start, then account id - the roster's input (the account id stays server-side). */
    suspend fun membersOf(connectionId: UInt, flowTeamId: Int): List<FlowMirrorMember> = suspendTransaction(database) {
        FlowMembers.selectAll().where { (FlowMembers.connectionId eq connectionId) and (FlowMembers.flowTeamId eq flowTeamId) }
            .orderBy(FlowMembers.validFrom to SortOrder.ASC, FlowMembers.accountId to SortOrder.ASC).toList().map {
                FlowMirrorMember(
                    accountId = it[FlowMembers.accountId],
                    displayName = it[FlowMembers.displayName],
                    validFrom = it[FlowMembers.validFrom],
                    validTo = it[FlowMembers.validTo],
                )
            }
    }

    companion object {
        /**
         * Removes every mirror row of the connection INSIDE the caller's open transaction (it opens none) and answers how many rows went:
         * the connection delete's step (`FlowConnectionService.delete`, the `sync_runs` pattern).
         */
        suspend fun deleteForConnectionInTransaction(connectionId: UInt): Int = deleteRowsOf(connectionId)

        /** The connection's mirror rows, or - with [only] - those of the named Flow teams (an empty list deletes nothing). */
        private suspend fun deleteRowsOf(connectionId: UInt, only: List<Int>? = null): Int {
            if (only != null && only.isEmpty()) return 0
            return FlowMembers.deleteWhere {
                (FlowMembers.connectionId eq connectionId) and (only?.let { FlowMembers.flowTeamId inList it } ?: Op.TRUE)
            } + FlowSprints.deleteWhere {
                (FlowSprints.connectionId eq connectionId) and (only?.let { FlowSprints.flowTeamId inList it } ?: Op.TRUE)
            } + FlowTeams.deleteWhere {
                (FlowTeams.connectionId eq connectionId) and (only?.let { FlowTeams.flowTeamId inList it } ?: Op.TRUE)
            }
        }
    }
}
