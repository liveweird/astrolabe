package ch.nokillswit.flow

import ch.nokillswit.planning.DeviationSeverity

// What each committed write of `CapacityAcknowledgeService` leaves for the route's audit lines (written AFTER the commit).

/** What a committed acknowledge leaves for the route's audit line (written AFTER the commit): the binding, its Flow team and the row. */
class CapacityAcknowledgeOutcome(
    val acknowledgement: CapacityAcknowledgement,
    val connectionId: UInt,
    val teamId: UInt,
    val flowTeamId: Int,
    val kind: CapacityDeviationKind,
    val severity: DeviationSeverity,
    /** The Flow sprint ids (null = the team's own row) of the binding's stored rows the write pruned because they were no longer listed. */
    val cleared: List<Long?>,
)

/** One row an acknowledge-all stored: its [acknowledgement] and the row's [kind] and [severity] (the per-row audit line's fields). */
class AcknowledgedCapacityRow(
    val acknowledgement: CapacityAcknowledgement,
    val kind: CapacityDeviationKind,
    val severity: DeviationSeverity,
)

/** What a committed acknowledge-all leaves for the route's audit lines: the binding, its Flow team, the rows (request order), the prune. */
class CapacityAcknowledgeAllOutcome(
    val rows: List<AcknowledgedCapacityRow>,
    val connectionId: UInt,
    val teamId: UInt,
    val flowTeamId: Int,
    /** As [CapacityAcknowledgeOutcome.cleared]. */
    val cleared: List<Long?>,
)

/** What a prune removed from ONE binding: the Flow sprint ids of the deleted rows, `null` standing for the team's own `TEAM_GONE` row. */
class ClearedCapacityAcks(val bindingId: UInt, val sprintIds: List<Long?>)

/** What a committed un-acknowledge leaves for the audit line: the binding and the fingerprint that was cleared. */
class CapacityUnacknowledgeOutcome(
    val connectionId: UInt,
    val teamId: UInt,
    val flowTeamId: Int,
    val fingerprint: String,
)

/** What a committed unacknowledge-all (1.11) leaves for the audit: the binding and the withdrawn (sprint, fingerprint) rows, in order. */
class CapacityUnacknowledgeAllOutcome(
    val rows: List<Pair<Long?, String>>,
    val connectionId: UInt,
    val teamId: UInt,
    val flowTeamId: Int,
)
