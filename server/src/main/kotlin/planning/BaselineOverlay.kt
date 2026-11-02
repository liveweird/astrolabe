@file:OptIn(ExperimentalSerializationApi::class)

package ch.nokillswit.planning

import ch.nokillswit.authz.TypedBadRequestException
import ch.nokillswit.infra.time.WorkingCalendar
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import java.math.BigDecimal

/*
 * The wire pieces every `?baseline=` overlay shares (`planning-model.md` "Baselines"): the movement of one row, the counts over a set of
 * rows, the baseline's identity and the 400 for a baseline the client holds that is gone. The overlays are ADDITIVE: every field they
 * add to a view defaults to null and carries `@EncodeDefault(NEVER)` (Ktor's JSON encodes defaults, which would write `"baseline":null`),
 * so a view requested WITHOUT the parameter answers the exact bytes it answered before the overlay existed (pinned by the view tests).
 */

/**
 * What happened to one row since the baseline ([BaselineKernels]). [startDays]/[endDays] are signed WORKING days on the current
 * calendar (positive = later) and are present only for a row dated on both sides; [estimateDelta] (`live - frozen`, man-days) whenever
 * the row exists on both sides, whatever the [kind].
 */
@Serializable
data class MovementView(val kind: MovementKind, val startDays: Int?, val endDays: Int?, val estimateDelta: Double?)

internal fun Movement.toView() = MovementView(kind, startDays, endDays, estimateDelta?.toDouble())

/** The counts over a set of rows ([BaselineKernels.totals]): [later]/[earlier] are the [moved] rows whose END is later/earlier. */
@Serializable
data class MovementTotalsView(
    val unchanged: Int,
    val moved: Int,
    val later: Int,
    val earlier: Int,
    val scheduled: Int,
    val unscheduled: Int,
    val added: Int,
    val removed: Int,
)

internal fun MovementTotals.toView() = MovementTotalsView(unchanged, moved, later, earlier, scheduled, unscheduled, added, removed)

/** The baseline an overlay was computed against; the plan revision it EQUALS (a view at that revision shows no movement). */
@Serializable
data class BaselineRef(val id: UInt, val name: String, val planRevision: Long)

internal fun BaselineHeader.toRef() = BaselineRef(id, name, planRevision)

/** A span then ([span], null = it had no dated work) and what became of it ([movement]): a project's, program's or work stream's. */
@Serializable
data class SpanBaseline(val span: DateSpan?, val movement: MovementView)

/**
 * The ACTIVE baseline [id], or the `400` of `?baseline=` ([UNKNOWN_BASELINE_PROBLEM]) when it is unknown or soft-deleted: the id is a
 * query value the client held, not the addressed resource (which would be a 404). Called by the views AFTER their own existence rules.
 */
internal suspend fun requireActiveBaseline(id: UInt): BaselineHeader =
    activeBaseline(id) ?: throw TypedBadRequestException("Unknown or deleted baseline id: $id", UNKNOWN_BASELINE_PROBLEM)

internal fun FrozenMilestoneRow.toKernel() = FrozenMilestone(id, projectId, teamId, name, estimateMd, span)

/** A milestone's frozen figures beside its [movement]: the dates and estimate the baseline took, the team it sat on then. */
@Serializable
data class BaselineMilestone(
    val milestoneId: UInt,
    val teamIdThen: UInt,
    val start: String?,
    val end: String?,
    val estimateMd: Double,
    val movement: MovementView,
)

internal fun frozenFigures(frozen: FrozenMilestoneRow, live: LiveMilestone, calendar: WorkingCalendar) =
    BaselineMilestone(
        milestoneId = frozen.id,
        teamIdThen = frozen.teamId,
        start = frozen.span?.start?.toString(),
        end = frozen.span?.end?.toString(),
        estimateMd = frozen.estimateMd.toDouble(),
        movement = BaselineKernels.milestoneMovement(frozen.toKernel(), live, calendar).toView(),
    )

/**
 * A frozen milestone that no longer sits where the view looks: [now] is the team it moved to (team view) and absent when the
 * milestone was deleted (or, on the project view, always: a milestone of a project that was removed from it was deleted).
 */
@Serializable
data class RemovedMilestone(
    val milestoneId: UInt,
    val projectId: UInt,
    val name: String,
    val teamId: UInt,
    val teamName: String,
    val estimateMd: Double,
    val start: String?,
    val end: String?,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val now: NowTeam? = null,
)

/** The team a milestone sits on now (a removed row of the team view whose milestone moved to another team). */
@Serializable
data class NowTeam(val teamId: UInt, val teamName: String)

internal fun FrozenMilestoneRow.toRemoved(teamName: String, now: LiveTeam?) = RemovedMilestone(
    milestoneId = id,
    projectId = projectId,
    name = name,
    teamId = teamId,
    teamName = teamName,
    estimateMd = estimateMd.toDouble(),
    start = span?.start?.toString(),
    end = span?.end?.toString(),
    now = now?.let { NowTeam(it.id, it.name) },
)

/** Removed rows in the order the page appends them: by start (undated last), end, name (case-insensitive), id. */
internal fun List<RemovedMilestone>.inAppendOrder(): List<RemovedMilestone> =
    sortedWith(compareBy<RemovedMilestone>({ it.start == null }, { it.start }, { it.end }, { it.name.lowercase() }, { it.milestoneId }))

/** True when the estimate changed (scale-insensitive: 10.0 and 10.00 are one figure). */
internal fun estimateChanged(delta: BigDecimal?): Boolean = delta != null && delta.signum() != 0
