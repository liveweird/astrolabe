package ch.nokillswit.planning

import io.ktor.server.plugins.BadRequestException
import kotlinx.serialization.Serializable

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
 * schedule was written after it (`milestones.schedule_revision`), never because of an unrelated plan write.
 */
@Serializable
data class TeamScheduleBatchRequest(
    val expectedRevision: Long,
    val items: List<TeamScheduleBatchItem>,
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

/**
 * The whole-batch rules checked BEFORE the lock, for client bugs only: a non-negative `expectedRevision`, between one and
 * [MAX_BATCH_SCHEDULE_ITEMS] items, no milestone id twice, and every item through [validateSchedule] (one date only, shape, order, a
 * weekend-only span; the holiday-aware half runs per item under the lock and SKIPS the item). A 400 names the failing item's index.
 */
fun validateBatchRequest(request: TeamScheduleBatchRequest): List<ValidatedBatchItem> {
    if (request.expectedRevision < 0) throw BadRequestException("expectedRevision must not be negative")
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
