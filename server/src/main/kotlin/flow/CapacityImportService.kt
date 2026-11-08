package ch.nokillswit.flow

import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.planning.loadWorkingCalendar
import ch.nokillswit.teams.TeamCapacityService
import io.ktor.util.AttributeKey
import io.r2dbc.spi.IsolationLevel
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import java.time.Instant
import java.time.LocalDate

val CapacityImportServiceKey = AttributeKey<CapacityImportService>("CapacityImportService")

/**
 * The capacity import's preview (`POST /integrations/flow/team-bindings/{id}/capacity-preview`; the apply is a later step). ONE
 * `READ ONLY REPEATABLE READ` transaction reads, in this order: the binding (ACTIVE, of an ACTIVE team) and its connection's zone, the
 * public-holiday calendar ([loadWorkingCalendar]), the Flow team in the mirror and its sprints, and the team's ACTIVE capacity periods
 * ([TeamCapacityService.importRowsOf]); the pure [CapacityImportKernels] then decides. Nothing is stored, locked, audited or sent to Flow.
 * "Today" is [now] in the connection's zone (the default of `from`); a test injects a fixed clock. A Flow team that is not in the mirror
 * (gone from Flow, or never mirrored) answers an empty plan: nothing is imported or removed on the strength of an absence.
 */
class CapacityImportService(
    private val database: R2dbcDatabase,
    private val bindings: FlowTeamBindingService,
    private val mirror: FlowMirrorStore,
    private val capacity: TeamCapacityService,
    private val now: () -> Long = ::nowMillis,
) {
    /** The preview of binding [bindingId], or null when the binding (or its team) is gone since the route's check: the route's `404`. */
    suspend fun preview(bindingId: UInt, from: LocalDate?, includeClosed: Boolean): CapacityPreview? =
        suspendTransaction(database, IsolationLevel.REPEATABLE_READ, readOnly = true) {
            val binding = bindings.bindingOf(bindingId) ?: return@suspendTransaction null
            val registry = FlowConnectionService.Connections
            val zoneId = registry.select(registry.timeZone).where { (registry.id eq binding.connectionId) and registry.active() }
                .toList().singleOrNull()?.get(registry.timeZone) ?: return@suspendTransaction null
            val zone = zoneOrUtc(zoneId)
            val calendar = loadWorkingCalendar()
            val observedAt = FlowTeams.select(FlowTeams.observedAt)
                .where { (FlowTeams.connectionId eq binding.connectionId) and (FlowTeams.flowTeamId eq binding.flowTeamId) }
                .toList().singleOrNull()?.get(FlowTeams.observedAt)
            val today = Instant.ofEpochMilli(now()).atZone(zone).toLocalDate()
            val plan = if (observedAt == null) {
                CapacityPlan(emptyList(), emptyList())
            } else {
                CapacityImportKernels.plan(
                    sprints = mirror.sprintsOf(binding.connectionId, binding.flowTeamId),
                    zone = zone,
                    calendar = calendar,
                    today = today,
                    existingPeriods = capacity.importRowsOf(binding.teamId),
                    from = from,
                    includeClosed = includeClosed,
                )
            }
            CapacityPreview(
                bindingId, binding.teamId, observedAt, zoneId, (from ?: today).toString(), includeClosed,
                plan.totals(), plan.items, plan.removals,
            )
        }
}
