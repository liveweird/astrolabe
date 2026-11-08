package ch.nokillswit.flow

import ch.nokillswit.infra.validation.parseIsoDate
import ch.nokillswit.teams.CapacitySource
import kotlinx.serialization.Serializable
import java.time.LocalDate

/**
 * `POST /integrations/flow/team-bindings/{id}/capacity-preview`: [from] is the first day the import is about (`YYYY-MM-DD`); a sprint
 * that ended before it is CLOSED. Absent = today in the connection's time zone. [includeClosed] also lists the closed sprints (unticked);
 * absent or false leaves them out. An empty object is a valid request.
 */
@Serializable
data class CapacityPreviewRequest(val from: String? = null, val includeClosed: Boolean = false)

/** The request's `from` parsed ([parseIsoDate]: `400` for a malformed or out-of-range date); null = the connection's today. */
fun validateCapacityPreview(request: CapacityPreviewRequest): LocalDate? = request.from?.let { parseIsoDate(it, "from") }

/**
 * What the import would do with one sprint. [SKIP] carries a [CapacitySkipReason]; [MANUAL_PERIOD] is the promise that a hand-entered
 * period is never changed: the sprint's start date already holds one, so the sprint is left alone.
 */
@Serializable
enum class CapacityAction { CREATE, UPDATE, UNCHANGED, MANUAL_PERIOD, SKIP }

/** Why a sprint is [CapacityAction.SKIP]ped, in the order the kernel asks. */
@Serializable
enum class CapacitySkipReason { NO_DATES, NO_CAPACITY, NO_WORKING_DAY, OVERLAPS, OUT_OF_RANGE }

/**
 * `MANUAL_PERIOD_INSIDE`: a hand-entered period starts on [CapacityInfo.date], inside the sprint - the figure will not hold from then.
 * `ZERO_CAPACITY`: Flow's figure is 0 (its DEFAULT for a team without members), so the row is never preselected.
 */
@Serializable
enum class CapacityInfoCode { MANUAL_PERIOD_INSIDE, ZERO_CAPACITY }

/** [date] is set for `MANUAL_PERIOD_INSIDE` only. */
@Serializable
data class CapacityInfo(val code: CapacityInfoCode, val date: String?)

/** The ACTIVE period that already starts on the sprint's start date. */
@Serializable
data class CapacityExisting(val periodId: UInt, val mdPerWeek: Double, val source: CapacitySource)

/**
 * One sprint of the preview. [start]/[end] are the sprint's first and last day in the connection's zone (null when Flow sent none; the
 * end is `dayOf(max(start, min(endAt, completeAt) - 1 ms))`); [effectiveFrom] is the day its period starts, `max(start, previous sprint's
 * end + 1 day)` (null when the sprint has no dates or overlaps); [workingDays] counts `effectiveFrom..end` on Astrolabe's calendar;
 * [flowMd] is Flow's total for the sprint; [mdPerWeek] is `round2(5 x flowMd / workingDays)`, null when no figure exists or it is out of
 * range. [ticked] is the default selection: not closed, not zero-capacity, and a CREATE or an UPDATE.
 */
@Serializable
data class CapacityImportItem(
    val sprintId: Long,
    val name: String,
    val state: String,
    val start: String?,
    val end: String?,
    val effectiveFrom: String?,
    val workingDays: Int?,
    val flowMd: Double?,
    val mdPerWeek: Double?,
    val action: CapacityAction,
    val reason: CapacitySkipReason?,
    val infos: List<CapacityInfo>,
    val ticked: Boolean,
    val existing: CapacityExisting?,
)

/**
 * A Flow-sourced period the import would remove: its sprint left Flow's document, it lies inside a sprint the import covers, or it
 * belongs to a covered sprint that now reuses another period. Removals are never preselected by a client.
 */
@Serializable
data class CapacityImportRemoval(
    val periodId: UInt,
    val effectiveFrom: String,
    val mdPerWeek: Double,
    val flowSprintId: Long?,
    val flowSprintName: String?,
)

/** [skip] counts the [CapacityAction.SKIP] and the [CapacityAction.MANUAL_PERIOD] rows: the sprints the import leaves alone. */
@Serializable
data class CapacityImportTotals(val create: Int, val update: Int, val unchanged: Int, val skip: Int, val removals: Int)

/**
 * The preview document. [observedAt] is when the mirror last saw the Flow team (null when the team is not in the mirror: then there are
 * no items and no removals - nothing is removed because a team vanished). [zone] is the connection's IANA id the dates are in. [from]
 * (resolved: the request's, else today in [zone]) and [includeClosed] echo what the plan was computed with, so the apply can re-run it.
 */
@Serializable
data class CapacityPreview(
    val bindingId: UInt,
    val teamId: UInt,
    val observedAt: Long?,
    val zone: String,
    val from: String,
    val includeClosed: Boolean,
    val totals: CapacityImportTotals,
    val items: List<CapacityImportItem>,
    val removals: List<CapacityImportRemoval>,
)
