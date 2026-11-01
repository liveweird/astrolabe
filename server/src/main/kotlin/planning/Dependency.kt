package ch.nokillswit.planning

import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

/** The most working days a lag (or a lead, negative) may span — the `ck_dependencies_lag` CHECK of V15 is the backstop. */
const val MAX_LAG_DAYS = 365

/**
 * The four classic link types. In every type the SUCCESSOR is the constrained side: FS = the successor starts after the predecessor
 * finishes, SS = starts after it starts, FF = finishes after it finishes, SF = finishes after it starts. A violated link only warns
 * (the project view's check); it never moves a date.
 */
@Serializable
enum class DependencyType { FS, SS, FF, SF }

/** What one end of a link is: a milestone or a project (the `pred_*`/`succ_*` column pair that is set). */
@Serializable
enum class EndpointKind { MILESTONE, PROJECT }

/** One end of a link as the client names it. */
@Serializable
data class EndpointRef(val kind: EndpointKind, val id: UInt)

/**
 * `POST /projects/{id}/dependencies` (V15): the [successor] must be project `{id}` itself or one of its ACTIVE milestones (the
 * successor's project chain is what authorizes the write); the [predecessor] is any active milestone or project. [lagDays] are
 * WORKING days, negative = a lead, at most [MAX_LAG_DAYS] either way.
 */
@Serializable
data class DependencyCreateRequest(
    val predecessor: EndpointRef,
    val successor: EndpointRef,
    val type: DependencyType,
    val lagDays: Int = 0,
)

/**
 * One end of a stored link with what the client needs to draw and name it: for a milestone its own project and team; for a project
 * ([projectId] is its own id) its DERIVED span (never its target window) as the dates, no team. Dates are null while unscheduled.
 */
@Serializable
data class DependencyEndpoint(
    val kind: EndpointKind,
    val id: UInt,
    val name: String,
    val projectId: UInt,
    val projectName: String,
    val teamId: UInt?,
    val teamName: String?,
    val startDate: String?,
    val endDate: String?,
)

/**
 * `PUT /dependencies/{id}`: the link's new [type] and [lagDays] (working days, negative = a lead, at most [MAX_LAG_DAYS] either way).
 * Both are required - a PUT replaces the editable part, there is no partial body - and the two ends are NOT editable (pointing a
 * link at another end is delete + add: the successor's project chain is what authorized it).
 */
@Serializable
data class DependencyUpdateRequest(val type: DependencyType, val lagDays: Int)

@Serializable
data class DependencyResponse(
    val id: UInt,
    val predecessor: DependencyEndpoint,
    val successor: DependencyEndpoint,
    val type: DependencyType,
    val lagDays: Int,
    val createdAt: Long,
    val updatedAt: Long,
)

/**
 * The request-shape rules checked before the lock (and again by the service): the lag within [MAX_LAG_DAYS], and no endpoint linked to
 * itself (400 — a validation error, not a cycle). A longer cycle, the successor's place in the project and the predecessor's
 * existence need the database and are checked under the plan lock.
 */
fun validateDependencyCreate(request: DependencyCreateRequest) {
    requireLagInRange(request.lagDays)
    if (request.predecessor == request.successor) throw BadRequestException("A dependency cannot link an endpoint to itself")
}

/** The request-shape rule of `PUT /dependencies/{id}` (route AND service): the lag within [MAX_LAG_DAYS]; the ends cannot change. */
fun validateDependencyUpdate(request: DependencyUpdateRequest) = requireLagInRange(request.lagDays)

private fun requireLagInRange(lagDays: Int) {
    if (lagDays !in -MAX_LAG_DAYS..MAX_LAG_DAYS) {
        throw BadRequestException("Lag must be between -$MAX_LAG_DAYS and $MAX_LAG_DAYS working days")
    }
}
