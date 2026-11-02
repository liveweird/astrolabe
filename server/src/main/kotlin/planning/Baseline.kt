package ch.nokillswit.planning

import ch.nokillswit.infra.validation.requireNameAndDescription
import ch.nokillswit.infra.validation.sanitizeSingleLine
import ch.nokillswit.infra.validation.sanitizedDescription
import kotlinx.serialization.Serializable

/** The most ACTIVE baselines the registry holds: the 101st create is a `409` (`urn:astrolabe:problem:baseline-limit`); delete one first. */
const val MAX_ACTIVE_BASELINES = 100
const val MAX_BASELINE_NAME_LENGTH = 100
const val MAX_BASELINE_DESCRIPTION_LENGTH = 500

/**
 * A baseline (V20): a named, immutable copy of the plan's dated structure taken at one plan revision (`planning-model.md` "Baselines").
 * [planRevision] is the plan revision the baseline EQUALS - the one its creation left behind, so a view whose `revision` equals it shows
 * no movement. [createdBy] is the creating login's linked ACTIVE person's name, else the login's display name (`users.name`, never its
 * email); null when that login is gone.
 */
@Serializable
data class BaselineResponse(
    val id: UInt,
    val name: String,
    val description: String?,
    val planRevision: Long,
    val createdAt: Long,
    val createdBy: BaselineCreator?,
    val milestoneCount: Int,
    val projectCount: Int,
)

/** The login that took a baseline: [name] is its ACTIVE person's name, else the login's display name - never its email. */
@Serializable
data class BaselineCreator(val userId: UInt, val name: String)

/** `POST /baselines`: the name (1..100, trimmed, unique among ACTIVE baselines, case-insensitively) and an optional description (≤ 500). */
@Serializable
data class BaselineCreateRequest(val name: String, val description: String? = null)

/** `PUT /baselines/{id}`: a full replace of the name and description - the frozen rows never change. */
@Serializable
data class BaselineUpdateRequest(val name: String, val description: String? = null)

/** [manage]: the caller may take, rename and delete baselines (ADMIN or a `ROADMAP_EDITOR`, [PlanPermissions.canManageBaselines]). */
@Serializable
data class BaselineCan(val manage: Boolean)

/**
 * `GET /baselines`: the ACTIVE baselines, newest first - a bounded `{items, can}` set (at most [MAX_ACTIVE_BASELINES] by the cap; the
 * picker needs all of them at once), not paged (`list-endpoints.md` "Sub-collections and facets").
 */
@Serializable
data class BaselineList(val items: List<BaselineResponse>, val can: BaselineCan)

/** The trimmed, validated name and description of a baseline write. */
data class BaselineValues(val name: String, val description: String?)

/** Trims the scalars (a control character is a 400); idempotent. */
fun sanitizedBaseline(name: String, description: String?): BaselineValues =
    BaselineValues(sanitizeSingleLine(name, "Name"), sanitizedDescription(description))

/** The baseline rules - enforced by the route AND re-checked by the service. */
fun validateBaseline(name: String, description: String?) {
    requireNameAndDescription(name, description, MAX_BASELINE_NAME_LENGTH, MAX_BASELINE_DESCRIPTION_LENGTH)
}

/** What a rename did, for the audit trail: [changed] is false when neither the name nor the description differs from the stored ones. */
data class BaselineUpdateOutcome(val nameFrom: String, val descriptionChanged: Boolean, val changed: Boolean)
