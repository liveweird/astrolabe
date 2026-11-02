package ch.nokillswit.planning

import ch.nokillswit.infra.validation.LAST_PLAN_DAY
import ch.nokillswit.infra.validation.parseIsoDate
import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable
import java.time.LocalDate

/** The most items one batch schedule may carry (`MAX_TEAM_ORDER_MILESTONES`' precedent; the largest sample team, Platform, holds 301). */
const val MAX_BATCH_SCHEDULE_ITEMS = 1000

/**
 * One item of the batch schedule: exactly the single `PUT /milestones/{id}/schedule` body without the revision
 * ([MilestoneScheduleRequest]): both dates or neither (the null pair unschedules), inclusive, the end not before the start, a working
 * day inside.
 */
@Serializable
data class TeamScheduleBatchItem(
    val milestoneId: UInt,
    val startDate: String? = null,
    val endDate: String? = null,
)

/**
 * The batch accept (`POST /teams/{id}/milestone-schedules`): N schedule PUTs in ONE plan write under the team's guard. [expectedRevision]
 * is the plan revision of the view the items were derived from (a proposal's `revision`); an item is stale only when ITS milestone's
 * schedule was written after it (`milestones.schedule_revision`), never because of an unrelated plan write. [scopeHash] is the
 * proposal's `scopeHash`: present = the accept of THAT proposal, refused whole (409 `stale-scope`) when the team's plan changed beyond
 * the batch's own milestones; absent = N schedule PUTs, no scope check (the v0.8 contract).
 */
@Serializable
data class TeamScheduleBatchRequest(
    val expectedRevision: Long,
    val items: List<TeamScheduleBatchItem>,
    val scopeHash: String? = null,
)

/** Why one item of a batch was not written (the rest were): API-DATA-003 named strings. */
@Serializable
enum class SkippedScheduleReason {
    /** The milestone's schedule was written after `expectedRevision` (somebody moved it since the view). */
    STALE,

    /** No ACTIVE milestone has this id (deleted since the view, or never existed). */
    GONE,

    /** The milestone is not on this team (moved to another team since the view, or never on it): not this manager's to schedule. */
    NOT_ON_TEAM,

    /** The span holds no working day of the CURRENT holiday calendar (a holiday added since the view, decision D2 of v0.7). */
    NO_WORKING_DAY,
}

@Serializable
data class SkippedSchedule(val milestoneId: UInt, val reason: SkippedScheduleReason)

/** The batch answer: the plan revision the write left behind, the written ids in body order and the skipped items with their reasons. */
@Serializable
data class TeamScheduleBatchResponse(
    val revision: Long,
    val accepted: List<UInt>,
    val skipped: List<SkippedSchedule>,
)

/** An item whose dates were written: the STORED span before and the span after (null = unscheduled), for the per-item audit. */
data class AcceptedSchedule(val milestoneId: UInt, val from: MilestoneSpan?, val to: MilestoneSpan?)

/** What a batch write did, for the route's answer and audit trail: [revision] is the plan revision it left behind. */
data class TeamBatchOutcome(val revision: Long, val accepted: List<AcceptedSchedule>, val skipped: List<SkippedSchedule>)

/** A validated item: its span is null for the unschedule pair. */
data class ValidatedBatchItem(val milestoneId: UInt, val span: MilestoneSpan?)

private val SCOPE_HASH = Regex("^[0-9a-f]{64}$")

/**
 * The whole-batch rules checked BEFORE the lock, for client bugs only: a non-negative `expectedRevision`, a `scopeHash` (when present)
 * of 64 lowercase hex digits, between one and
 * [MAX_BATCH_SCHEDULE_ITEMS] items, no milestone id twice, and every item through [validateSchedule] (one date only, shape, order, a
 * weekend-only span; the holiday-aware half runs per item under the lock and SKIPS the item). A 400 names the failing item's index.
 */
fun validateBatchRequest(request: TeamScheduleBatchRequest): List<ValidatedBatchItem> {
    if (request.expectedRevision < 0) throw BadRequestException("expectedRevision must not be negative")
    if (request.scopeHash != null && !SCOPE_HASH.matches(request.scopeHash)) {
        throw BadRequestException("scopeHash must be 64 lowercase hexadecimal characters")
    }
    val items = request.items
    if (items.isEmpty()) throw BadRequestException("items must list at least one milestone")
    if (items.size > MAX_BATCH_SCHEDULE_ITEMS) {
        throw BadRequestException("items must list at most $MAX_BATCH_SCHEDULE_ITEMS milestones")
    }
    if (items.map { it.milestoneId }.toSet().size != items.size) throw BadRequestException("items must name each milestone once")
    return items.mapIndexed { index, item ->
        val span = try {
            validateSchedule(item.startDate, item.endDate)
        } catch (e: BadRequestException) {
            throw BadRequestException("items[$index]: ${e.message}", e)
        }
        ValidatedBatchItem(item.milestoneId, span)
    }
}

/**
 * `POST /teams/{id}/schedule-proposal`: [asOf] is the VIEWER's calendar day (the clock the kernel must not read): a team milestone is
 * movable when unscheduled or when its start is after it. The wire is day precision, an ISO `YYYY-MM-DD` date.
 */
@Serializable
data class ScheduleProposalRequest(val asOf: String)

/**
 * One movable milestone the proposal puts on other dates: [from] is its stored span (null = unscheduled), [to] the proposed one,
 * [workingDays] the working days in [to] (at least 1) and [shiftDays] how many working days later (+) or earlier (-) the proposed
 * start is than the current one (null when newly scheduled).
 */
@Serializable
data class ScheduleProposalMove(
    val milestoneId: UInt,
    val name: String,
    val projectId: UInt,
    val projectName: String,
    val estimateMd: Double,
    val from: DateSpan?,
    val to: DateSpan,
    val workingDays: Int,
    val shiftDays: Int?,
)

/** A movable milestone the proposal could not place ([ScheduleKernels]' no-capacity and no-room verdicts). */
@Serializable
data class ScheduleProposalUnplaced(
    val milestoneId: UInt,
    val name: String,
    val projectId: UInt,
    val projectName: String,
    val reason: UnplacedReason,
)

/**
 * One end of a [ScheduleProposalLink], named and nothing else: the page prints the other end's words and reads every date from the link's
 * `check`. [projectName] is the milestone's project for a milestone end, null for a project end (whose [name] IS the project).
 */
@Serializable
data class ScheduleProposalEnd(
    val kind: EndpointKind,
    val id: UInt,
    val name: String,
    val projectName: String?,
)

/**
 * A link the proposal touches AND whose verdict is or was VIOLATED (fine both times, or unscheduled then fine, is not worth a row): both
 * ends named ([ScheduleProposalEnd]), its status [before] (on the stored dates) and its [check] after the moves. A link into another team's
 * fixed milestone that the proposal breaks reads `before: OK`, `VIOLATED`.
 */
@Serializable
data class ScheduleProposalLink(
    val id: UInt,
    val predecessor: ScheduleProposalEnd,
    val successor: ScheduleProposalEnd,
    val type: DependencyType,
    val lagDays: Int,
    val before: DependencyStatus,
    val check: DependencyCheck,
)

/**
 * The proposal (`POST /teams/{id}/schedule-proposal`, listed under "Batch commands" in `list-endpoints.md`; bounded by ONE
 * team's milestones, at most [MAX_LOAD_WEEKS] weeks and the links touching the team whose verdict is or was violated). A computation:
 * nothing is stored. [revision] is the plan revision of the snapshot it was computed from - the batch accept's `expectedRevision`.
 * [moves] and [unplaced] are in the team's effective order; [unchanged] are the movable milestones that stay on their dates; [weeks]
 * is the team's load AFTER accepting every move (the team view's row shape); [dependencies] are violated-after first; [scopeHash] is the
 * fingerprint of the team's plan the proposal read (`ScheduleScope.kt`), which the batch accept sends back to be checked.
 */
@Serializable
data class ScheduleProposal(
    val revision: Long,
    val asOf: String,
    val teamId: UInt,
    val moves: List<ScheduleProposalMove>,
    val unchanged: List<UInt>,
    val unplaced: List<ScheduleProposalUnplaced>,
    val weeks: List<WeekLoadView>,
    val weeksTruncated: Boolean,
    val dependencies: List<ScheduleProposalLink>,
    val scopeHash: String,
)

/**
 * The latest `asOf` a proposal accepts: a placement may lie [MAX_LOAD_WEEKS] weeks (the horizon) past the first usable day, plus one week
 * for the weekend or holiday that day may skip, and the batch accept refuses a date past [LAST_PLAN_DAY] - so a later `asOf` could
 * produce a proposal that cannot be accepted.
 */
private val LATEST_AS_OF: LocalDate = LAST_PLAN_DAY.minusWeeks(MAX_LOAD_WEEKS + 1L)

/**
 * The proposal request's rules, checked after the guard: `asOf` is an ISO date in the planning calendar's years ([parseIsoDate]) and
 * not after [LATEST_AS_OF] (a 400 otherwise).
 */
fun validateProposalRequest(request: ScheduleProposalRequest): LocalDate {
    val asOf = parseIsoDate(request.asOf, "asOf")
    if (asOf.isAfter(LATEST_AS_OF)) throw BadRequestException("asOf must not be after $LATEST_AS_OF")
    return asOf
}
