package ch.nokillswit.flow

import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.teams.TeamService
import io.ktor.util.AttributeKey
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import java.time.Instant

val FlowTeamServiceKey = AttributeKey<FlowTeamService>("FlowTeamService")

/** Q2a: every signed-in user sees the roster. The audience rule is [rosterVisibleTo]; flipping to Q2b is changing this one constant. */
private val ROSTER_AUDIENCE = RosterAudience.EVERY_LOGIN

/**
 * The reads of the Flow team binding: `GET /integrations/flow/teams` (a connection's mirrored teams with their binding and suggestion) and
 * `GET /teams/{id}/flow` (the team page's panel, with the active connections' id, name and enabled flag). READ-ONLY and made of the
 * mirror, the bindings, the connection registry and `teams` (active names); it calls Flow never. Each read is one transaction. Nothing
 * here returns an account id, an email, a token or a base URL.
 * [now] defaults to the wall clock (the composition root passes none); `FlowTeamPanelTest` injects a fixed one to pin the roster's
 * half-open intervals and the next sprint through [panel].
 */
class FlowTeamService(
    private val database: R2dbcDatabase,
    private val connections: FlowConnectionService,
    private val mirror: FlowMirrorStore,
    private val now: () -> Long = ::nowMillis,
) {
    /**
     * The mirror of [connectionId] (an ACTIVE connection, enabled or not; null = missing or deleted) by Flow team name. A Flow team bound
     * to an ACTIVE team carries it; an unbound one carries the unique unbound active team its name matches, if any.
     */
    suspend fun list(connectionId: UInt): FlowTeamList? = suspendTransaction(database) {
        val registry = FlowConnectionService.Connections
        val registryRow = registry.select(registry.teamsAt).where { (registry.id eq connectionId) and registry.active() }
            .toList().singleOrNull() ?: return@suspendTransaction null
        val teamsAt = registryRow[registry.teamsAt]
        val rows = mirror.teamsOf(connectionId)
        val bindings = FlowTeamBindingService.Bindings
        val teams = TeamService.Teams
        val bound = bindings.innerJoin(teams).select(bindings.id, bindings.flowTeamId, bindings.teamId, teams.name)
            .where { (bindings.connectionId eq connectionId) and bindings.active() and teams.active() }
            .toList().associateBy { it[bindings.flowTeamId] }
        val boundTeamIds = bindings.select(bindings.teamId).where { bindings.active() }.toList().map { it[bindings.teamId].value }.toSet()
        val candidates = teams.select(teams.id, teams.name).where { teams.active() }.toList()
            .map { it[teams.id].value to it[teams.name] }.filter { it.first !in boundTeamIds }
        val suggestions = FlowTeamMatchKernels.suggest(rows.filter { it.flowTeamId !in bound }.map { it.flowTeamId to it.name }, candidates)
        val teamNames = candidates.toMap()
        FlowTeamList(
            connectionId,
            teamsAt,
            rows.map { row ->
                val binding = bound[row.flowTeamId]
                val suggested = suggestions[row.flowTeamId]
                FlowTeamListItem(
                    flowTeamId = row.flowTeamId,
                    name = row.name,
                    bindingId = binding?.get(bindings.id)?.value,
                    boundTeamId = binding?.get(bindings.teamId)?.value,
                    boundTeamName = binding?.get(teams.name),
                    suggestedTeamId = suggested,
                    suggestedTeamName = suggested?.let(teamNames::get),
                    members = row.memberCount,
                    sprints = row.sprintCount,
                    observedAt = row.observedAt,
                )
            },
        )
    }

    /**
     * The panel of ACTIVE team [teamId] (null = missing or deleted, a `404`). [manages] is the caller's verdict (ADMIN or the team's
     * ACTIVE manager) and only sets the `can` flags and the roster audience. An unbound team gets `binding`, `roster` and `sprints` null.
     */
    suspend fun panel(teamId: UInt, manages: Boolean): FlowTeamPanel? = suspendTransaction(database) {
        val teams = TeamService.Teams
        val team = teams.select(teams.id, teams.name).where { (teams.id eq teamId) and teams.active() }.toList().singleOrNull()
            ?: return@suspendTransaction null
        val panelTeam = FlowPanelTeam(teamId, team[teams.name])
        val can = FlowPanelCan(link = manages, unlink = manages, importCapacity = manages)
        val registry = FlowConnectionService.Connections
        val offered = registry.select(registry.id, registry.name, registry.enabled).where { registry.active() }
            .orderBy(registry.name to SortOrder.ASC, registry.id to SortOrder.ASC).limit(MAX_PANEL_CONNECTIONS).toList()
            .map { FlowPanelConnection(it[registry.id].value, it[registry.name], it[registry.enabled]) }
        val bindings = FlowTeamBindingService.Bindings
        val stored = bindings.select(bindings.connectionId, bindings.flowTeamId, bindings.flowTeamName, bindings.id)
            .where { (bindings.teamId eq teamId) and bindings.active() }.toList().singleOrNull()
        val connection = stored?.let { connections.read(it[bindings.connectionId].value) }
        if (stored == null || connection == null) return@suspendTransaction FlowTeamPanel(panelTeam, can, null, null, null, offered)
        val connectionId = connection.id
        val flowTeamId = stored[bindings.flowTeamId]
        val observed = FlowTeams.select(FlowTeams.observedAt)
            .where { (FlowTeams.connectionId eq connectionId) and (FlowTeams.flowTeamId eq flowTeamId) }
            .toList().singleOrNull()?.get(FlowTeams.observedAt)
        // Gone = the connection HAS mirrored a document and the Flow team is not in it (before the first run there is nothing to miss).
        val gone = connection.teamsAt != null && observed == null
        val binding = FlowPanelBinding(
            id = stored[bindings.id].value,
            connectionId = connectionId,
            connectionName = connection.name,
            flowTeamId = flowTeamId,
            flowTeamName = stored[bindings.flowTeamName],
            connectionEnabled = connection.enabled,
            status = connection.status,
            observedAt = observed ?: connection.teamsAt,
            gone = gone,
        )
        if (observed == null) return@suspendTransaction FlowTeamPanel(panelTeam, can, binding, null, null, offered)
        val zone = zoneOrUtc(connection.timeZone)
        val at = now()
        val sprints = mirror.sprintsOf(connectionId, flowTeamId)
        val roster = if (rosterVisibleTo(ROSTER_AUDIENCE, manages)) rosterOf(mirror.membersOf(connectionId, flowTeamId), zone, at) else null
        val today = Instant.ofEpochMilli(at).atZone(zone).toLocalDate()
        val summary = FlowSprintSummary(sprints.size, nextSprintStart(sprints, zone, today)?.toString())
        FlowTeamPanel(panelTeam, can, binding, roster, summary, offered)
    }
}
