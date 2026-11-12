package ch.nokillswit.flow

import ch.nokillswit.authz.NotFoundException
import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.nowMillis
import ch.nokillswit.planning.loadWorkingCalendar
import ch.nokillswit.teams.CapacityImportApplied
import ch.nokillswit.teams.CapacityWriteTrail
import ch.nokillswit.teams.TeamCapacityService
import ch.nokillswit.teams.TeamGuard
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
 * The capacity import: the preview (`POST /integrations/flow/team-bindings/{id}/capacity-preview`) and the apply. The preview's ONE
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
            val zoneId = zoneIdOf(binding.connectionId) ?: return@suspendTransaction null
            val zone = zoneOrUtc(zoneId)
            val calendar = loadWorkingCalendar()
            val observedAt = observedAtOf(binding)
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

    /**
     * The apply (`POST …/capacity-import`): [TeamCapacityService.applyImport] first lets the capacity-write listeners lock the team's
     * binding row (1.13.3: [CapacityAcknowledgeService.lockBindingsBeforeCapacityWrite], the acknowledge's order), then locks the team
     * row (404 when it is gone), re-runs [guard] under it (403: a manager cleared while this waited), shows this block the team's ACTIVE
     * periods read under the lock, and this block re-runs [CapacityImportKernels.plan] over the mirror rows read NOW (with the request's
     * echoed `from` and `includeClosed`) and lets [CapacityApplyKernels.decide] compare every requested row with that plan. Only rows
     * the plan still confirms are written; the rest are skipped `CHANGED`. A binding unlinked while the apply waited is a 404 and
     * nothing is written. Writes nothing to Flow and takes no plan lock: capacity periods are team data.
     *
     * The Flow team and its sprints come from ONE statement ([FlowMirrorStore.teamSprintsOf]), so a mirror refresh that drops the team
     * reads as "not in the mirror" (an empty plan, everything skipped), never as a team with no sprints (which would offer every Flow
     * period for removal). The binding is re-read in the transaction UNDER the binding row lock the listeners took (an unlink committed
     * before that lock is a 404; none can commit after it). A write that changed a period also settles the team's acknowledgements
     * in this transaction (queued audit on [trail]).
     */
    suspend fun apply(
        bindingId: UInt,
        command: CapacityApplyCommand,
        trail: CapacityWriteTrail = CapacityWriteTrail(),
        guard: TeamGuard,
    ): CapacityImportOutcome {
        val binding = bindings.bindingOf(bindingId) ?: throw NotFoundException(BINDING_NOT_FOUND)
        val applied = capacity.applyImport(binding.teamId, guard, trail) { periods ->
            bindings.bindingOf(bindingId)?.takeIf { it.teamId == binding.teamId } ?: throw NotFoundException(BINDING_NOT_FOUND)
            val zone = zoneOrUtc(zoneIdOf(binding.connectionId) ?: throw NotFoundException(BINDING_NOT_FOUND))
            val calendar = loadWorkingCalendar()
            val team = mirror.teamSprintsOf(binding.connectionId, binding.flowTeamId)
            val plan = if (team == null) {
                CapacityPlan(emptyList(), emptyList())
            } else {
                val today = Instant.ofEpochMilli(now()).atZone(zone).toLocalDate()
                CapacityImportKernels.plan(team.sprints, zone, calendar, today, periods, command.from, command.includeClosed)
            }
            val decision = CapacityApplyKernels.decide(plan, command)
            decision.writes to decision.skipped
        }
        return CapacityImportOutcome(binding.id, binding.connectionId, binding.teamId, applied)
    }

    /** The connection's IANA zone id, or null when the connection is deleted. */
    private suspend fun zoneIdOf(connectionId: UInt): String? {
        val registry = FlowConnectionService.Connections
        return registry.select(registry.timeZone).where { (registry.id eq connectionId) and registry.active() }
            .toList().singleOrNull()?.get(registry.timeZone)
    }

    /** When the mirror last saw the bound Flow team; null = it is not in the mirror. */
    private suspend fun observedAtOf(binding: FlowTeamBindingRow): Long? =
        FlowTeams.select(FlowTeams.observedAt)
            .where { (FlowTeams.connectionId eq binding.connectionId) and (FlowTeams.flowTeamId eq binding.flowTeamId) }
            .toList().singleOrNull()?.get(FlowTeams.observedAt)
}

private const val BINDING_NOT_FOUND = "Flow team binding not found"

/** What an apply did, for the route's response and its audit (after the commit). */
class CapacityImportOutcome(
    val bindingId: UInt,
    val connectionId: UInt,
    val teamId: UInt,
    val applied: CapacityImportApplied<List<CapacityApplySkipped>>,
) {
    val response: CapacityApplyResponse
        get() = CapacityApplyResponse(
            created = applied.created.map { CapacityAppliedPeriod(it.periodId, it.flowSprintId) },
            updated = applied.updated.map { CapacityAppliedPeriod(it.periodId, it.flowSprintId) },
            deleted = applied.deleted,
            skipped = applied.extra,
        )
}
