package ch.nokillswit.planning

import ch.nokillswit.infra.paging.PageResponse
import ch.nokillswit.infra.time.WorkingCalendar
import ch.nokillswit.infra.validation.parseIsoDate
import ch.nokillswit.infra.validation.requireDateOrder
import ch.nokillswit.infra.validation.requireNameAndDescription
import ch.nokillswit.infra.validation.sanitizeSingleLine
import ch.nokillswit.infra.validation.sanitizedDescription
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable
import java.math.BigDecimal
import java.time.LocalDate

/**
 * Milestones (V14), the fourth level of the plan, under a project: a name (unique among the ACTIVE milestones of the SAME project), an
 * optional description, EXACTLY ONE team (an ACTIVE team, 400 otherwise) and a man-day estimate; no owner. The plan fields below are
 * edited by the owner chain of the project (`PUT /milestones/{id}`), the DATES only by the team's manager or ADMIN
 * ([MilestoneScheduleRequest], `PUT /milestones/{id}/schedule`). A new milestone is always UNSCHEDULED: the create body carries no dates.
 * The parent project is fixed at create (`POST /projects/{id}/milestones`).
 */
@Serializable
data class MilestoneCreateRequest(
    val name: String,
    val description: String? = null,
    /** The milestone's team — an ACTIVE team (400 otherwise). */
    val teamId: UInt,
    /** Man-days: finite, `0 <= x < 1_000_000`, at most two decimals ([validateManDays]). */
    val estimateMd: Double,
)

/** The plan fields of a milestone — never the dates (that is [MilestoneScheduleRequest]). PUT is a full replace. */
@Serializable
data class MilestoneUpdateRequest(
    val name: String,
    val description: String? = null,
    val teamId: UInt,
    val estimateMd: Double,
)

/**
 * The schedule write: [startDate] and [endDate] both set or both null (the null pair unschedules), inclusive, the end not before the
 * start, covering at least one working day. [expectedRevision] is the plan revision of the client's view; the write is a 409 only when
 * THIS milestone's schedule was written at a later revision (`milestones.schedule_revision`, per-milestone optimistic concurrency).
 */
@Serializable
data class MilestoneScheduleRequest(
    val expectedRevision: Long,
    val startDate: String? = null,
    val endDate: String? = null,
)

/**
 * The pin write (`PUT /milestones/{id}/pin`): [pinned] true keeps the milestone's dates fixed for the auto-proposal, false releases it.
 * Idempotent and carrying no revision: the pin is advice to the planner, and an accept that raced a flipped pin is refused by the
 * proposal's `scopeHash` (`stale-scope`).
 */
@Serializable
data class MilestonePinRequest(val pinned: Boolean)

/** The plan revision after a schedule write — the client's next `expectedRevision` for any milestone it still holds. */
@Serializable
data class ScheduleResponse(val revision: Long)

@Serializable
data class MilestoneResponse(
    val id: UInt,
    val projectId: UInt,
    val name: String,
    val description: String?,
    val teamId: UInt,
    val teamName: String,
    val estimateMd: Double,
    val startDate: String?,
    val endDate: String?,
    /** The auto-proposal keeps the dates (V25); only ever true while scheduled. */
    val pinned: Boolean,
    val createdAt: Long,
    val updatedAt: Long,
)

/**
 * A list row of `GET /api/v1/milestones` (the picker list): the [MilestoneResponse] fields plus the name of the (ACTIVE) project, so the
 * picker can tell the many milestones called "Design" apart ("Design · Project Alpha").
 */
@Serializable
data class MilestoneListItem(
    val id: UInt,
    val projectId: UInt,
    val projectName: String,
    val name: String,
    val description: String?,
    val teamId: UInt,
    val teamName: String,
    val estimateMd: Double,
    val startDate: String?,
    val endDate: String?,
    /** The auto-proposal keeps the dates (V25); only ever true while scheduled. */
    val pinned: Boolean,
    val createdAt: Long,
    val updatedAt: Long,
)

typealias MilestonePageResponse = PageResponse<MilestoneListItem>

/** The one list filter: a case- and accent-insensitive substring of the milestone name. */
data class MilestoneListFilter(val name: String? = null)

data class MilestoneListResult(val items: List<MilestoneListItem>, val total: Long)

/** A validated milestone schedule: an inclusive span of days. */
data class MilestoneSpan(val start: LocalDate, val end: LocalDate)

/** What a plan-field update replaced, for the audit delta: the STORED team before the write. */
data class MilestoneUpdateOutcome(val teamFrom: UInt)

/**
 * What a schedule write replaced: the STORED span before it (null = unscheduled), the team it was checked against, the new revision and
 * whether the write CLEARED a pin ([pinCleared]: an unschedule of a pinned milestone, audited as `milestone.unpinned`).
 */
data class ScheduleOutcome(val from: MilestoneSpan?, val teamId: UInt, val revision: Long, val pinCleared: Boolean = false)

/** What a pin write found: the STORED pin [before], the team the guard checked and the plan revision the write left behind. */
data class PinOutcome(val before: Boolean, val teamId: UInt, val revision: Long)

// `estimateMd + 0.0` normalises a negative zero (which passes `>= 0`) to 0.0, so the audit never logs `-0.0`.
fun MilestoneCreateRequest.sanitized(): MilestoneCreateRequest =
    copy(name = sanitizeSingleLine(name, "Name"), description = sanitizedDescription(description), estimateMd = estimateMd + 0.0)

fun MilestoneUpdateRequest.sanitized(): MilestoneUpdateRequest =
    copy(name = sanitizeSingleLine(name, "Name"), description = sanitizedDescription(description), estimateMd = estimateMd + 0.0)

/** The milestone field rules — enforced by the route AND re-checked by the service; returns the estimate as the exact stored decimal. */
fun validateMilestoneFields(name: String, description: String?, estimateMd: Double): BigDecimal {
    requireNameAndDescription(name, description, MAX_PLAN_NAME_LENGTH, MAX_PLAN_DESCRIPTION_LENGTH)
    return validateManDays(estimateMd, "Estimate")
}

private const val MAX_MAN_DAYS = 1_000_000.0
private const val MAN_DAYS_SCALE = 2

/**
 * A man-day figure (a milestone's estimate, a team's capacity per week): finite, non-negative, below one million and with at most two
 * decimals, so the stored `NUMERIC(8,2)` is exactly the sent value (never a silent rounding). The decimals are read off the double's
 * shortest decimal text (`12.25`, `0.1`), the form the JSON parser produced it from; zero is allowed (a zero-effort checkpoint, a team
 * on hold). A 400 names [field].
 */
fun validateManDays(value: Double, field: String): BigDecimal {
    val message = "$field must be a non-negative man-day figure with at most two decimals"
    if (!value.isFinite() || value < 0.0 || value >= MAX_MAN_DAYS) throw BadRequestException(message)
    val exact = BigDecimal(value.toString()).stripTrailingZeros()
    if (exact.scale() > MAN_DAYS_SCALE) throw BadRequestException(message)
    return exact.setScale(MAN_DAYS_SCALE)
}

/** The schedule request rules: a non-negative `expectedRevision` (400, as the spec's `minimum: 0` promises), then [validateSchedule]. */
fun validateScheduleRequest(request: MilestoneScheduleRequest): MilestoneSpan? {
    if (request.expectedRevision < 0) throw BadRequestException("expectedRevision must not be negative")
    return validateSchedule(request.startDate, request.endDate)
}

/** The 400 for a span without a working day: [validateSchedule] raises it for a weekend-only span, the write for a holiday-only. */
const val NO_WORKING_DAY_MESSAGE = "A milestone must cover at least one working day"

/**
 * The schedule rules: both dates or neither (400 otherwise; neither = unschedule, null result), each an ISO date, the end not before the
 * start, and at least one Monday-Friday day inside the span ([NO_WORKING_DAY_MESSAGE]). This is the pure, calendar-free half: it runs
 * before any lock and knows no holidays; `MilestoneService.schedule` adds the holiday-aware check under the plan lock (D2).
 */
fun validateSchedule(startDate: String?, endDate: String?): MilestoneSpan? {
    if ((startDate == null) != (endDate == null)) {
        throw BadRequestException("Start date and end date must be set together or both omitted")
    }
    if (startDate == null || endDate == null) return null
    val start = parseIsoDate(startDate, "Start date")
    val end = parseIsoDate(endDate, "End date")
    requireDateOrder(start, end)
    if (!WorkingCalendar.MON_FRI.containsWorkingDay(start, end)) {
        throw BadRequestException(NO_WORKING_DAY_MESSAGE)
    }
    return MilestoneSpan(start, end)
}
