package ch.nokillswit.flow

import ch.nokillswit.infra.db.SoftDeletable
import ch.nokillswit.infra.db.active
import ch.nokillswit.teams.TeamService
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.dao.id.UIntIdTable
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

val FlowTeamBindingServiceKey = AttributeKey<FlowTeamBindingService>("FlowTeamBindingService")

/** An ACTIVE binding of an Astrolabe team to a Flow team of a connection (the id of the Flow team is the key; the name is display only). */
data class FlowTeamBindingRow(
    val id: UInt,
    val connectionId: UInt,
    val teamId: UInt,
    val flowTeamId: Int,
    /** The Flow team's name when it was linked: a rename in Flow does not change it, the binding follows [flowTeamId]. */
    val flowTeamName: String,
    val createdAt: Long,
)

/**
 * The team bindings (V24 `flow_team_bindings`): the 1:1 link of an Astrolabe team to a Flow team that feeds the roster and the capacity
 * import. Not plan state: no plan lock, no revision. Soft-deleted = unlinked. In this step the service owns the TABLE and the read
 * ([bindingsOf]); the writes (link, unlink, match by name, with their locks and guards) arrive with the binding routes.
 * [FlowConnectionService.delete] soft-deletes a connection's bindings in its own transaction through [Bindings].
 */
class FlowTeamBindingService(private val database: R2dbcDatabase) {
    object Bindings : UIntIdTable("flow_team_bindings"), SoftDeletable {
        val connectionId = reference("connection_id", FlowConnectionService.Connections)

        /** No `ON DELETE` rule: teams are only soft-deleted. */
        val teamId = reference("team_id", TeamService.Teams)
        val flowTeamId = integer("flow_team_id")
        val flowTeamName = varchar("flow_team_name", length = FLOW_TEAM_NAME_WIDTH)

        /** The linking login's id (`users.id` is BIGINT; V24 has the FK, no `users` import here: `flow/` names no `users` type). */
        val createdByUserId = long("created_by_user_id")
        val createdAt = long("created_at")
        val updatedAt = long("updated_at")
        override val markedAsDeleted = bool("marked_as_deleted").default(false)
    }

    /**
     * The ACTIVE bindings of one connection in id order, of ACTIVE teams only: a team's soft delete leaves its binding active (`teams/`
     * may not name `flow/`), so a binding of a dead team is not a binding to anyone reading. A bound team's `gone` is derived from the
     * mirror at read time, never stored.
     */
    suspend fun bindingsOf(connectionId: UInt): List<FlowTeamBindingRow> = suspendTransaction(database) {
        val teams = TeamService.Teams
        Bindings.innerJoin(teams).selectAll()
            .where { (Bindings.connectionId eq connectionId) and Bindings.active() and teams.active() }
            .orderBy(Bindings.id to SortOrder.ASC).toList().map {
                FlowTeamBindingRow(
                    id = it[Bindings.id].value,
                    connectionId = connectionId,
                    teamId = it[Bindings.teamId].value,
                    flowTeamId = it[Bindings.flowTeamId],
                    flowTeamName = it[Bindings.flowTeamName],
                    createdAt = it[Bindings.createdAt],
                )
            }
    }
}
