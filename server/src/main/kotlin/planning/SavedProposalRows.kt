package ch.nokillswit.planning

import ch.nokillswit.plugins.ApiJson
import kotlinx.serialization.decodeFromString
import org.jetbrains.exposed.v1.core.ResultRow

/**
 * A saved proposal's facts as stored, WITHOUT its documents (the list and the delete never select `document` or `check_document`):
 * [teams] as named at the save, in id order.
 */
internal class SavedHeader(
    val id: UInt,
    val name: String,
    val asOf: String,
    val planRevision: Long,
    val createdAt: Long,
    val createdByUserId: UInt?,
    val teams: List<SavedProposalTeam>,
    val moveCount: Int,
    val selectedCount: Int,
    val passes: Int,
    val settled: Boolean,
) {
    val teamIds: List<UInt> get() = teams.map { it.id }

    fun toSummary(creators: Map<UInt, BaselineCreator>, actor: PlanActor) = SavedProposalSummary(
        id = id,
        name = name,
        asOf = asOf,
        planRevision = planRevision,
        createdAt = createdAt,
        createdBy = createdByUserId?.let(creators::get),
        teams = teams,
        moveCount = moveCount,
        selectedCount = selectedCount,
        passes = passes,
        settled = settled,
        can = SavedProposalListCan(PlanPermissions.canDeleteSavedProposal(actor, teamIds)),
    )
}

private val Rows = SavedProposalService.SavedProposals

/** The columns of a [SavedHeader] (every column but the documents, the hash, the ticks and the format). */
internal val SAVED_HEADER_COLUMNS = listOf(
    Rows.id, Rows.name, Rows.asOf, Rows.planRevision, Rows.createdAt, Rows.createdByUserId, Rows.teams, Rows.moveCount,
    Rows.selectedCount, Rows.passes, Rows.settled,
)

internal fun ResultRow.toSavedHeader() = SavedHeader(
    id = this[Rows.id].value,
    name = this[Rows.name],
    asOf = this[Rows.asOf].toString(),
    planRevision = this[Rows.planRevision],
    createdAt = this[Rows.createdAt],
    createdByUserId = this[Rows.createdByUserId]?.value,
    teams = ApiJson.decodeFromString<List<SavedProposalTeam>>(this[Rows.teams]),
    moveCount = this[Rows.moveCount],
    selectedCount = this[Rows.selectedCount],
    passes = this[Rows.passes],
    settled = this[Rows.settled],
)

/**
 * Whether the proposal stored with [scopeHash] at [planRevision] still describes the plan, inside the caller's snapshot: CHANGED when a
 * team is gone (or not active), when either digest of the CURRENT scope differs from the stored token's (the structure, with the
 * teams' current names, or the holidays) or when a milestone of a run team was rescheduled after [planRevision]; else CURRENT. The
 * very loader and digests the run and the save use, so "the scope the save compared" and "the scope this compares" are one function.
 */
internal suspend fun savedProposalState(teamIds: List<UInt>, scopeHash: String, planRevision: Long): SavedProposalState {
    val names = activeTeamNames(teamIds)
    if (names.size != teamIds.size) return SavedProposalState.CHANGED
    val current = loadCrossTeamSnapshot(names).scopeDigests()
    val unchanged = current == ScopeToken(scopeHash).digests && !reschedulesOutsideBatch(teamIds, planRevision, emptyList())
    return if (unchanged) SavedProposalState.CURRENT else SavedProposalState.CHANGED
}
