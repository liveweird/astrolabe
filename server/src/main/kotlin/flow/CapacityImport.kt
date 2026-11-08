package ch.nokillswit.flow

import ch.nokillswit.infra.validation.parseIsoDate
import ch.nokillswit.planning.validateManDays
import ch.nokillswit.teams.CapacitySource
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable
import java.math.BigDecimal
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
 * `LONG_WINDOW`: the sprint spans more calendar days than Flow's 60-day calendar cap (check its dates in Jira); Flow lets every sprint
 * within the 60-day cap claim first, so it counts only the days no other sprint holds (its one period holds only until the next period
 * starts), and the row is never preselected.
 * `FIXED_FIGURE`: Flow's figure is a fixed per-sprint total (the team's default), spread over the sprint's own window of [CapacityInfo.days]
 * working days, more than the days the row holds (some of its days belong to an earlier sprint).
 */
@Serializable
enum class CapacityInfoCode { MANUAL_PERIOD_INSIDE, ZERO_CAPACITY, LONG_WINDOW, FIXED_FIGURE }

/** [date] is set for `MANUAL_PERIOD_INSIDE` only, [days] for `FIXED_FIGURE` only. */
@Serializable
data class CapacityInfo(val code: CapacityInfoCode, val date: String?, val days: Int? = null)

/** The ACTIVE period that already starts on the sprint's start date. */
@Serializable
data class CapacityExisting(val periodId: UInt, val mdPerWeek: Double, val source: CapacitySource)

/**
 * One sprint of the preview. [start]/[end] are the sprint's first and last day in the connection's zone (null when Flow sent none; the
 * end is `dayOf(max(start, (endAt ?: completeAt) - 1 ms))`, the planned end first); [effectiveFrom] is the day its period starts,
 * `max(start, the last day an earlier sprint holds + 1 day)` (null when the sprint has no dates or lies wholly inside earlier ones);
 * [workingDays] counts `effectiveFrom..end` on Astrolabe's calendar;
 * [flowMd] is Flow's total for the sprint; [mdPerWeek] is `round2(5 x flowMd / workingDays)` (a `TEAM_DEFAULT` sprint divides by the
 * working days of its own window instead: Flow's figure for it is fixed per sprint), null when no figure exists or it is out of
 * range. [ticked] is the default selection: not closed, not zero-capacity, not a long window, and a CREATE or an UPDATE.
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
 * belongs to a listed sprint that now reuses another period or holds no day. Removals are never preselected by a client.
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

/** The most rows an apply may name in `items` (one per sprint of the document: Flow's own cap) and in `removals`. */
const val MAX_CAPACITY_APPLY_ROWS = 2_000

/** What the preview showed for a row the person ticked; the apply imports it only while the plan it re-runs still says the same. */
@Serializable
data class CapacityApplyExpected(val action: CapacityAction, val effectiveFrom: String, val mdPerWeek: Double)

@Serializable
data class CapacityApplyItem(val sprintId: Long, val expected: CapacityApplyExpected)

/**
 * `POST /integrations/flow/team-bindings/{id}/capacity-import`: the ticked rows of a preview, with the [from] and [includeClosed] the
 * preview echoed (the apply re-runs the kernel with them) and the [removals] (period ids) the person ticked.
 */
@Serializable
data class CapacityApplyRequest(
    val from: String? = null,
    val includeClosed: Boolean = false,
    val items: List<CapacityApplyItem>,
    val removals: List<UInt>,
)

/** A ticked row, validated: only a `CREATE` or an `UPDATE` can be imported. */
data class CapacityApplyRow(val sprintId: Long, val action: CapacityAction, val effectiveFrom: LocalDate, val mdPerWeek: BigDecimal)

/** The validated request. */
data class CapacityApplyCommand(
    val from: LocalDate?,
    val includeClosed: Boolean,
    val items: List<CapacityApplyRow>,
    val removals: List<UInt>,
)

/**
 * The apply's body rules (`400`): the lists within [MAX_CAPACITY_APPLY_ROWS], no sprint or period named twice, `from` a valid date, each
 * row an expected `CREATE` or `UPDATE` with a valid date and a man-day figure ([validateManDays]). Whether a row is still true is decided
 * under the lock, not here.
 */
fun validateCapacityApply(request: CapacityApplyRequest): CapacityApplyCommand {
    if (request.items.size > MAX_CAPACITY_APPLY_ROWS) throw BadRequestException("items must have at most $MAX_CAPACITY_APPLY_ROWS rows")
    if (request.removals.size > MAX_CAPACITY_APPLY_ROWS) {
        throw BadRequestException("removals must have at most $MAX_CAPACITY_APPLY_ROWS rows")
    }
    if (request.items.map { it.sprintId }.toSet().size != request.items.size) throw BadRequestException("items must name each sprint once")
    if (request.removals.toSet().size != request.removals.size) throw BadRequestException("removals must name each period once")
    val rows = request.items.map {
        val expected = it.expected
        if (expected.action != CapacityAction.CREATE && expected.action != CapacityAction.UPDATE) {
            throw BadRequestException("expected.action must be CREATE or UPDATE")
        }
        CapacityApplyRow(
            it.sprintId, expected.action, parseIsoDate(expected.effectiveFrom, "expected.effectiveFrom"),
            validateManDays(expected.mdPerWeek, "expected.mdPerWeek"),
        )
    }
    return CapacityApplyCommand(request.from?.let { parseIsoDate(it, "from") }, request.includeClosed, rows, request.removals)
}

/** Why the apply left a row alone: the plan, re-run under the team lock, no longer says what the preview did. */
@Serializable
enum class CapacityApplySkipReason { CHANGED }

/** A skipped row: [sprintId] for an item, [periodId] for a removal (the other is null). */
@Serializable
data class CapacityApplySkipped(val sprintId: Long?, val periodId: UInt?, val reason: CapacityApplySkipReason)

/** A period the apply wrote and the Flow sprint it is for. */
@Serializable
data class CapacityAppliedPeriod(val periodId: UInt, val sprintId: Long)

/** `created`/`updated` are the periods written, `deleted` the soft-deleted period ids, `skipped` what was left alone. */
@Serializable
data class CapacityApplyResponse(
    val created: List<CapacityAppliedPeriod>,
    val updated: List<CapacityAppliedPeriod>,
    val deleted: List<UInt>,
    val skipped: List<CapacityApplySkipped>,
)
