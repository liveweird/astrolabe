package ch.nokillswit.planning

import ch.nokillswit.infra.paging.PageResponse
import ch.nokillswit.infra.validation.parseIsoDate
import ch.nokillswit.infra.validation.requireDateOrder
import ch.nokillswit.infra.validation.requireNameAndDescription
import ch.nokillswit.infra.validation.sanitizeSingleLine
import ch.nokillswit.infra.validation.sanitizedDescription
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable
import java.time.LocalDate

/**
 * Projects (V12), the third level: a name (unique among active projects of the SAME program), an optional description, a REQUIRED
 * owner and an optional target window (both dates or neither, end not before start). The parent program is set at create
 * (`POST /programs/{id}/projects`) and changes only through `POST /projects/{id}/move` ([ProjectMoveRequest]). The window is NOT part
 * of the field update: it has its own wider-audience endpoint (`PUT /projects/{id}/target-window` — the owners above the project and
 * the roadmap editors, `authorization.md`); creators are always window editors, so the create body may carry it.
 */
@Serializable
data class ProjectCreateRequest(
    val name: String,
    val description: String? = null,
    /** The owner — an ACTIVE person (400 otherwise). */
    val ownerPersonId: UInt,
    val targetStart: String? = null,
    val targetEnd: String? = null,
)

/** The project's own fields — no window (that is [TargetWindowRequest]). PUT is a full replace: an omitted description is unset. */
@Serializable
data class ProjectUpdateRequest(
    val name: String,
    val description: String? = null,
    val ownerPersonId: UInt,
)

/** PUT is a full replace: omitting both clears the window; one without the other is a 400. */
@Serializable
data class TargetWindowRequest(
    val targetStart: String? = null,
    val targetEnd: String? = null,
)

@Serializable
data class ProjectResponse(
    val id: UInt,
    val programId: UInt,
    val workStreamId: UInt,
    val name: String,
    val description: String?,
    val ownerPersonId: UInt,
    val ownerName: String,
    val targetStart: String?,
    val targetEnd: String?,
    val createdAt: Long,
    val updatedAt: Long,
)

/**
 * A list row of `GET /api/v1/projects` (the picker list): the [ProjectResponse] fields plus the names the picker shows ("Project Alpha ·
 * Program · Work stream"), resolved from the ACTIVE ancestors, so they are never stale or empty.
 */
@Serializable
data class ProjectListItem(
    val id: UInt,
    val programId: UInt,
    val workStreamId: UInt,
    val name: String,
    val description: String?,
    val ownerPersonId: UInt,
    val ownerName: String,
    val targetStart: String?,
    val targetEnd: String?,
    val programName: String,
    val workStreamName: String,
    val createdAt: Long,
    val updatedAt: Long,
)

typealias ProjectPageResponse = PageResponse<ProjectListItem>

/** The one list filter: a case- and accent-insensitive substring of the project name. */
data class ProjectListFilter(val name: String? = null)

data class ProjectListResult(val items: List<ProjectListItem>, val total: Long)

/** A validated target window. */
data class TargetWindow(val start: LocalDate, val end: LocalDate)

/** What a field update replaced, for the audit delta: the STORED owner before the write. */
data class ProjectUpdateOutcome(val ownerFrom: UInt)

/** What a project delete cascaded, for the audit: the ACTIVE milestones' count and the ACTIVE dependencies (either end, with ids). */
data class ProjectDeleteOutcome(val milestoneCount: Int, val dependencies: DeletedDependencies)

/** The stored window before a target-window write (both null = none), for the audit delta. */
data class TargetWindowOutcome(val from: TargetWindow?)

fun ProjectCreateRequest.sanitized(): ProjectCreateRequest =
    copy(name = sanitizeSingleLine(name, "Name"), description = sanitizedDescription(description))

fun ProjectUpdateRequest.sanitized(): ProjectUpdateRequest =
    copy(name = sanitizeSingleLine(name, "Name"), description = sanitizedDescription(description))

/** The project field rules — enforced by the route AND re-checked by the service. */
fun validateProjectFields(name: String, description: String?) =
    requireNameAndDescription(name, description, MAX_PLAN_NAME_LENGTH, MAX_PLAN_DESCRIPTION_LENGTH)

/** The project create rules: the fields and the optional window. */
fun validateProjectCreate(request: ProjectCreateRequest): TargetWindow? {
    validateProjectFields(request.name, request.description)
    return validateTargetWindow(request.targetStart, request.targetEnd)
}

/**
 * The window rules: both dates or neither (400 otherwise), each an ISO date, the end not before the start. Null = no window.
 */
fun validateTargetWindow(targetStart: String?, targetEnd: String?): TargetWindow? {
    if ((targetStart == null) != (targetEnd == null)) {
        throw BadRequestException("Target start and end must be set together or both omitted")
    }
    if (targetStart == null || targetEnd == null) return null
    val start = parseIsoDate(targetStart, "Target start")
    val end = parseIsoDate(targetEnd, "Target end")
    requireDateOrder(start, end)
    return TargetWindow(start, end)
}
