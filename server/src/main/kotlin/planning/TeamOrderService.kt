package ch.nokillswit.planning

import ch.nokillswit.authz.ConflictException
import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.insertRows
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.teams.TeamGuard
import ch.nokillswit.teams.TeamService
import io.ktor.server.plugins.BadRequestException
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.core.vendors.ForUpdateOption
import org.jetbrains.exposed.v1.r2dbc.*

val TeamOrderServiceKey = AttributeKey<TeamOrderService>("TeamOrderService")

/**
 * The team milestone order (V17): per team, the positions its manager gave to the team's milestones (`team_milestone_orders`), and the
 * plan revision at which the order was last written (`team_order_state`). A hard-delete position join rewritten wholesale
 * (`persistence.md` "Soft delete"). The write is a plan write ([withPlanWrite]: the revision compare and the rewrite are atomic with
 * every other plan writer), but it compares against THIS team's order revision, never the plan revision — another team's reorder or any
 * other plan write elsewhere never stales it (`planning-model.md` "The team milestone order").
 */
class TeamOrderService(private val database: R2dbcDatabase) {
    object TeamMilestoneOrders : Table("team_milestone_orders") {
        val milestoneId = reference("milestone_id", MilestoneService.Milestones)
        val teamId = reference("team_id", TeamService.Teams)
        val position = integer("position")
        override val primaryKey = PrimaryKey(milestoneId)
    }

    object TeamOrderState : Table("team_order_state") {
        val teamId = reference("team_id", TeamService.Teams)
        val revision = long("revision")
        val updatedAt = long("updated_at")
        override val primaryKey = PrimaryKey(teamId)
    }

    /**
     * Replaces the team's whole order under the plan lock, in this order: the team is re-read (gone = 404) -> [guard] (the caller's
     * `requireTeamManagerOrAdmin` against the team's manager as of the lock: 403, no bump) -> the stale check -> every id must name an
     * ACTIVE milestone OF THIS TEAM (400) -> the rewrite: the listed milestones get positions 1..n in order, every other milestone of
     * the team is unlisted; an empty list removes every row (the reset). The stale check is `stored order revision > expectedRevision`
     * or `expectedRevision >` the plan revision under the lock (a view from the future): 409 `urn:astrolabe:problem:stale-revision`,
     * nothing written. A team never written has no stored revision, so its first write passes with any valid `expectedRevision`. The
     * order revision then becomes the plan revision this write leaves behind. A throw anywhere rolls the bump back with the rest.
     */
    suspend fun replaceOrder(teamId: UInt, request: TeamOrderUpdateRequest, guard: TeamGuard): TeamOrderOutcome {
        validateTeamOrder(request)
        val ids = request.milestoneIds
        val write = database.withPlanWrite { revision ->
            lockActiveTeam(teamId)
            guard(teamId)
            if (orderRevisionOf(teamId) > request.expectedRevision || request.expectedRevision > revision) {
                throw ConflictException(
                    "This team's order changed after revision ${request.expectedRevision}; reload the team",
                    problemType = STALE_REVISION_PROBLEM,
                )
            }
            requireMilestonesOfTeam(teamId, ids)
            val before = positionsOf(teamId).keys.toList()
            TeamMilestoneOrders.deleteWhere { TeamMilestoneOrders.teamId eq teamId }
            TeamMilestoneOrders.insertRows(ids.withIndex()) { (index, id) ->
                this[TeamMilestoneOrders.milestoneId] = id
                this[TeamMilestoneOrders.teamId] = teamId
                this[TeamMilestoneOrders.position] = index + 1
            }
            stampOrderRevision(teamId, revision + 1)
            before
        }
        return TeamOrderOutcome(revisionFrom = write.revision - 1, revisionTo = write.revision, orderFrom = write.value)
    }

    private suspend fun stampOrderRevision(teamId: UInt, revision: Long) {
        val stamp = nowMillis()
        val updated = TeamOrderState.update({ TeamOrderState.teamId eq teamId }) {
            it[TeamOrderState.revision] = revision
            it[updatedAt] = stamp
        }
        if (updated == 0) {
            TeamOrderState.insert {
                it[TeamOrderState.teamId] = teamId
                it[TeamOrderState.revision] = revision
                it[updatedAt] = stamp
            }
        }
    }
}

/**
 * The team must still be ACTIVE (else 404), and its row is locked `FOR SHARE` for every caller, ADMIN included (the manager guard
 * locks it only for a non-admin): `TeamService.delete` holds `FOR NO KEY UPDATE`, so a delete racing a team-scoped plan write (the
 * team order, the batch schedule) either commits first (404 here) or waits for it, and no state row is ever stamped for a team that
 * went away in between. Runs inside the caller's plan-locked transaction.
 */
internal suspend fun lockActiveTeam(teamId: UInt) {
    val teams = TeamService.Teams
    val found = teams.select(teams.id).where { (teams.id eq teamId) and teams.active() }
        .forUpdate(ForUpdateOption.PostgreSQL.ForShare).toList().isNotEmpty()
    if (!found) throw NotFoundException("Team not found")
}

/**
 * Every id must name an ACTIVE milestone whose team is [teamId] — a client-supplied id is a 400, never a foreign-key 500, and a
 * milestone of another team cannot enter this team's order. The plan lock the caller holds keeps the answer true until commit (a
 * milestone's team and deletion only change under it).
 */
private suspend fun requireMilestonesOfTeam(teamId: UInt, ids: List<UInt>) {
    if (ids.isEmpty()) return
    val milestones = MilestoneService.Milestones
    val found = milestones.select(milestones.id)
        .where { (milestones.id inList ids) and (milestones.teamId eq teamId) and milestones.active() }
        .toList()
        .map { it[milestones.id].value }.toSet()
    val missing = ids.filter { it !in found }
    if (missing.isNotEmpty()) {
        throw BadRequestException(
            "Unknown, deleted or other-team milestone ids: ${missing.take(MAX_LISTED_MISSING).joinToString(", ")}",
        )
    }
}

private const val MAX_LISTED_MISSING = 20

/** The team's stored order revision, or 0 when its order was never written. Runs inside the caller's transaction. */
internal suspend fun orderRevisionOf(teamId: UInt): Long =
    TeamOrderService.TeamOrderState.select(TeamOrderService.TeamOrderState.revision)
        .where { TeamOrderService.TeamOrderState.teamId eq teamId }.toList()
        .singleOrNull()?.get(TeamOrderService.TeamOrderState.revision) ?: 0L

/**
 * The team's listed milestones with their positions, in position order (the map keeps it). Runs inside the caller's transaction; the
 * team view reads the custom order through it. A row may name a milestone that is no longer active only if a removal hook was bypassed, so
 * a reader looks positions up FROM the team's ACTIVE milestones (a map lookup per milestone), never the other way round.
 */
internal suspend fun positionsOf(teamId: UInt): Map<UInt, Int> {
    val orders = TeamOrderService.TeamMilestoneOrders
    return orders.select(orders.milestoneId, orders.position).where { orders.teamId eq teamId }.orderBy(orders.position).toList()
        .associate { it[orders.milestoneId].value to it[orders.position] }
}

/**
 * Takes a milestone out of its team's order and closes the gap ([removeFromTeamOrders] for one id): `MilestoneService.update` calls it
 * when the milestone changes team and `MilestoneService.delete` when it is deleted, in the same plan-locked transaction. A milestone
 * the team never listed is a no-op. The team's order revision is NOT bumped: the manager's list is still the manager's list.
 */
internal suspend fun removeFromTeamOrder(milestoneId: UInt) = removeFromTeamOrders(listOf(milestoneId))

/**
 * Takes [milestoneIds] out of their teams' orders and closes each gap, so every team's positions stay 1..n: the rows are hard-deleted
 * and, from the highest removed position down, ONE `UPDATE … SET position = position - 1 WHERE team_id = ? AND position > ?` per removed
 * row (which `uq_team_milestone_orders_position`, DEFERRABLE INITIALLY DEFERRED, only checks at commit). `ProjectService.delete` calls
 * it with the project's milestone ids before they are soft-deleted. Unlisted ids are a no-op.
 */
internal suspend fun removeFromTeamOrders(milestoneIds: Collection<UInt>) {
    if (milestoneIds.isEmpty()) return
    val orders = TeamOrderService.TeamMilestoneOrders
    val removed = orders.select(orders.teamId, orders.position).where { orders.milestoneId inList milestoneIds }.toList()
        .map { it[orders.teamId].value to it[orders.position] }
    if (removed.isEmpty()) return
    orders.deleteWhere { orders.milestoneId inList milestoneIds }
    for ((teamId, position) in removed.sortedByDescending { it.second }) {
        orders.update({ (orders.teamId eq teamId) and (orders.position greater position) }) { it[orders.position] = orders.position - 1 }
    }
}
