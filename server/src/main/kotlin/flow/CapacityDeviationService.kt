package ch.nokillswit.flow

import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.planning.loadWorkingCalendar
import ch.nokillswit.sync.SyncRunService
import ch.nokillswit.teams.CapacityPeriodRow
import ch.nokillswit.teams.TeamCapacityService
import io.ktor.util.AttributeKey
import io.r2dbc.spi.IsolationLevel
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import java.time.Instant
import java.time.ZoneOffset

val CapacityDeviationServiceKey = AttributeKey<CapacityDeviationService>("CapacityDeviationService")

/**
 * The filters of `GET /views/capacity-deviations` (each null = unrestricted). [severity] and [kind] narrow the ROWS of a team, not only
 * the team: the unit of this view is a sprint, so "warnings only" must list only the warning sprints.
 */
data class CapacityDeviationFilter(
    val connectionId: UInt? = null,
    val teamId: UInt? = null,
    val severity: DeviationSeverity? = null,
    val kind: CapacityDeviationKind? = null,
)

/**
 * The capacity deviation document (`GET /views/capacity-deviations`): ONE `READ ONLY REPEATABLE READ` transaction (the capacity import
 * preview's protocol) that reads, in this order: the public-holiday calendar ([loadWorkingCalendar]); every ACTIVE Flow connection (the
 * view's `connections`, at most [MAX_PANEL_CONNECTIONS], enabled or not) with the status derived from its newest runs; the ACTIVE bindings
 * of ACTIVE teams on them ([FlowTeamBindingService.activeBindingsWithTeams]); the ACTIVE capacity periods of every bound team in one
 * statement ([TeamCapacityService.importRowsOfTeams]); then, per binding, the Flow team and its sprints from ONE statement
 * ([FlowMirrorStore.teamSprintsOf]). The pure [CapacityDeviationKernels] over [CapacityImportKernels.plan] decides each team.
 *
 * A binding whose connection has never mirrored a document (`teamsAt` null) is not a deviation (nothing to compare); one whose
 * connection has and whose Flow team is absent from the mirror is `TEAM_GONE` (the panel's rule, [FlowTeamService.panel]). A DISABLED,
 * FAILED or STALE connection's teams are computed from its last mirrored document; the connection's status qualifies them. Nothing is
 * stored, locked, audited or sent to Flow, and there is no `revision`: capacity periods are team data and no plan revision moves with
 * them. [now] is the view's clock (`asOf` is its UTC date; each connection's "today" is the same instant in its own zone) and [maxItems]
 * the cap on teams; a test injects both.
 */
class CapacityDeviationService(
    private val database: R2dbcDatabase,
    private val bindings: FlowTeamBindingService,
    private val mirror: FlowMirrorStore,
    private val capacity: TeamCapacityService,
    private val runs: SyncRunService,
    private val now: () -> Long = ::nowMillis,
    private val maxItems: Int = MAX_CAPACITY_DEVIATION_ITEMS,
) {
    suspend fun view(filter: CapacityDeviationFilter): CapacityDeviationView =
        suspendTransaction(database, IsolationLevel.REPEATABLE_READ, readOnly = true) {
            val at = now()
            val calendar = loadWorkingCalendar()
            val registry = connectionsOf(filter.connectionId)
            val bound = bindings.activeBindingsWithTeams(registry.map { it.wire.id }, filter.teamId)
            val periods = capacity.importRowsOfTeams(bound.map { it.binding.teamId }.distinct())
            val byConnection = registry.associateBy { it.wire.id }
            val items = bound.mapNotNull { row ->
                itemOf(row, checkNotNull(byConnection[row.binding.connectionId]), periods[row.binding.teamId].orEmpty(), calendar, at)
            }.map { it.narrowedTo(filter) }.filter { it.deviations.isNotEmpty() }.sortedWith(ITEM_ORDER)
            val deviations = items.flatMap { it.deviations }
            CapacityDeviationView(
                asOf = Instant.ofEpochMilli(at).atOffset(ZoneOffset.UTC).toLocalDate().toString(),
                connections = registry.map { it.wire },
                totals = CapacityDeviationTotals(
                    warnings = deviations.count { it.severity == DeviationSeverity.WARNING },
                    infos = deviations.count { it.severity == DeviationSeverity.INFO },
                    gone = deviations.count { it.kind == CapacityDeviationKind.TEAM_GONE },
                    teams = items.size,
                ),
                items = items.take(maxItems),
                truncated = items.size > maxItems,
            )
        }

    /** The team's item, or null when there is nothing to compare (the connection never mirrored a document) or nothing deviates. */
    private suspend fun itemOf(
        row: FlowTeamBindingWithTeam,
        connection: ConnectionFacts,
        periods: List<CapacityPeriodRow>,
        calendar: WorkingCalendar,
        at: Long,
    ): CapacityDeviationItem? {
        val binding = row.binding
        val team = mirror.teamSprintsOf(binding.connectionId, binding.flowTeamId)
        if (team == null && connection.wire.teamsAt == null) return null
        val deviations = if (team == null) {
            CapacityDeviationKernels.deviations(CapacityPlan(emptyList(), emptyList()), periods, calendar, gone = true)
        } else {
            val zone = zoneOrUtc(connection.timeZone)
            val plan = CapacityImportKernels.plan(
                sprints = team.sprints,
                zone = zone,
                calendar = calendar,
                today = Instant.ofEpochMilli(at).atZone(zone).toLocalDate(),
                existingPeriods = periods,
                from = null,
                includeClosed = false,
            )
            CapacityDeviationKernels.deviations(plan, periods, calendar, gone = false)
        }
        if (deviations.isEmpty()) return null
        return CapacityDeviationItem(
            bindingId = binding.id,
            connectionId = binding.connectionId,
            team = CapacityDeviationTeam(binding.teamId, row.teamName),
            flowTeam = CapacityDeviationFlowTeam(binding.flowTeamId, binding.flowTeamName),
            observedAt = team?.observedAt,
            zone = connection.timeZone,
            deviations = deviations,
        )
    }

    /** The ACTIVE connections (or the one asked for) by name then id with their derived status; only the columns the status needs. */
    private suspend fun connectionsOf(connectionId: UInt?): List<ConnectionFacts> {
        val registry = FlowConnectionService.Connections
        val rows = registry.select(
            registry.id, registry.name, registry.enabled, registry.timeZone, registry.pollIntervalMinutes,
            registry.lastTestOk, registry.teamsAt, registry.updatedAt, registry.lastTestedAt,
        ).where { registry.active() and (connectionId?.let { registry.id eq it } ?: Op.TRUE) }
            .orderBy(registry.name.lowerCase() to SortOrder.ASC, registry.id to SortOrder.ASC)
            .limit(MAX_PANEL_CONNECTIONS).toList()
        val statuses = runs.statusesInTransaction(rows.map { it.toConnectorConnection() })
        return rows.zip(statuses) { row, status ->
            ConnectionFacts(
                CapacityDeviationConnection(
                    row[registry.id].value, row[registry.name], row[registry.enabled], status, row[registry.teamsAt],
                ),
                row[registry.timeZone],
            )
        }
    }

    private fun CapacityDeviationItem.narrowedTo(filter: CapacityDeviationFilter): CapacityDeviationItem =
        copy(
            deviations = deviations.filter {
                (filter.severity == null || it.severity == filter.severity) && (filter.kind == null || it.kind == filter.kind)
            },
        )
}

/** What a connection row adds to the wire shape: its IANA zone id (the sprint dates' zone), which the wire connection never carries. */
private class ConnectionFacts(val wire: CapacityDeviationConnection, val timeZone: String)

/** A team with a WARNING first, then by team name (lowercase), then binding id. */
private val ITEM_ORDER: Comparator<CapacityDeviationItem> = compareBy<CapacityDeviationItem>(
    { item -> if (item.deviations.any { it.severity == DeviationSeverity.WARNING }) 0 else 1 },
    { it.team.name.lowercase() },
    { it.bindingId },
)
