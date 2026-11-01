package ch.nokillswit.teams

import ch.nokillswit.infra.paging.PageResponse
import ch.nokillswit.infra.validation.sanitizeSingleLine
import ch.nokillswit.infra.validation.requireNameAndDescription
import ch.nokillswit.infra.validation.sanitizedDescription
import kotlinx.serialization.Serializable

/**
 * Flat teams (V6): a name and a description — the ownership unit future features scope to; there is no roster — and an
 * optional manager (V6, a person of the people directory since V10): at most one per team, assigned by an ADMIN;
 * being a manager grants no write on the team record itself — it gates the team-scoped planning writes (milestone dates, V14; the
 * team's capacity periods, V16, `TeamCapacity.kt`). No chain:
 * Lettuce's management-chain rule is deliberately NOT ported (see
 * `.claude/docs/authorization.md`). ADMIN curates teams and their manager; everyone reads them.
 */
const val MAX_TEAM_NAME_LENGTH = 100
const val MAX_TEAM_DESCRIPTION_LENGTH = 500

@Serializable
data class TeamCreateRequest(
    val name: String,
    val description: String? = null,
    /** Optional manager — an ACTIVE person of the people directory (400 otherwise); omitted = no manager. */
    val managerPersonId: UInt? = null,
)

@Serializable
data class TeamUpdateRequest(
    val name: String,
    val description: String? = null,
    /** PUT is a full replace: omitted = unset. An ACTIVE person (400 otherwise). */
    val managerPersonId: UInt? = null,
)

@Serializable
data class TeamResponse(
    val id: UInt,
    val name: String,
    val description: String?,
    /** The manager as an ACTIVE person; null when unset OR when the assigned person was soft-deleted. */
    val managerPersonId: UInt?,
    val managerName: String?,
    val createdAt: Long,
    val updatedAt: Long,
)

/** The list row. */
@Serializable
data class TeamListItem(
    val id: UInt,
    val name: String,
    val description: String?,
    val managerPersonId: UInt?,
    val managerName: String?,
    val createdAt: Long,
    val updatedAt: Long,
)

typealias TeamPageResponse = PageResponse<TeamListItem>

data class TeamListFilter(
    val name: String? = null,
)

/** `affected` is the updated-row count (0 → 404); `managerFrom` the STORED manager before the write (the audit delta). */
data class TeamUpdateOutcome(val affected: Int, val managerFrom: UInt?)

/** `affected` is the soft-deleted team count (0 → 404); `capacityPeriodCount` the ACTIVE capacity periods the delete cascaded (V16). */
data class TeamDeleteOutcome(val affected: Int, val capacityPeriodCount: Int)

data class TeamListResult(val items: List<TeamListItem>, val total: Long)

/** Trims the scalars (the sanitizer convention — control characters are a 400). */
fun sanitizedTeamCreate(request: TeamCreateRequest): TeamCreateRequest = TeamCreateRequest(
    name = sanitizeSingleLine(request.name, "Name"),
    description = sanitizedDescription(request.description),
    managerPersonId = request.managerPersonId,
)

fun sanitizedTeamUpdate(request: TeamUpdateRequest): TeamUpdateRequest = TeamUpdateRequest(
    name = sanitizeSingleLine(request.name, "Name"),
    description = sanitizedDescription(request.description),
    managerPersonId = request.managerPersonId,
)

/** The team rules — enforced by the route AND re-checked by the service. */
fun validateTeam(name: String, description: String?) {
    requireNameAndDescription(name, description, MAX_TEAM_NAME_LENGTH, MAX_TEAM_DESCRIPTION_LENGTH)
}

fun validateTeamCreate(request: TeamCreateRequest) = validateTeam(request.name, request.description)

fun validateTeamUpdate(request: TeamUpdateRequest) = validateTeam(request.name, request.description)
