package ch.nokillswit.planning

import ch.nokillswit.infra.db.nowMillis
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.r2dbc.update

/**
 * The one-row revision lock of the live plan (V12 `plan_state`, `planning-model.md` "The lock protocol"). Its `revision` is
 * monotonic and bumped by every plan mutation; it is the upper BOUND of both wholesale PUTs' `expectedRevision` (a value above it is
 * stale) and the expectation of neither: the ranking PUT (V13) compares against [rankingRevision] (V18, the plan revision at which
 * `roadmap_entries` was last written) and the team-order PUT (V17) against its own team's `team_order_state.revision`, so a plan
 * write elsewhere never stales either. It is also the seed of the future view ETags and the anchor baselines record.
 */
object PlanState : Table("plan_state") {
    val id = short("id")
    val revision = long("revision")

    /** The plan revision at which the ranking was last written (V18); never above [revision]. */
    val rankingRevision = long("ranking_revision")
    val updatedAt = long("updated_at")
    override val primaryKey = PrimaryKey(id)
}

private const val PLAN_STATE_ID: Short = 1

/** What a locked plan write produced and the revision it left behind. */
data class PlanWrite<T>(val value: T, val revision: Long)

/**
 * Runs [block] as ONE plan write: a transaction that first takes `plan_state` `FOR UPDATE` (every writer of the work streams,
 * programs, projects, milestones (V14), dependencies (V15), the team milestone orders (V17), the public holidays (V19), the
 * baselines (V20) and — from V13 — the ranking serializes here, so a read-then-write inside [block], such as "count the active
 * children, then delete", cannot interleave with another plan writer), hands [block] the revision it started from, and bumps the
 * revision by one when it returns. A [block] that throws (a 404, 409 or 400 found after the lock) rolls the whole transaction back,
 * so a rejected write never moves the revision.
 *
 * Plain `FOR UPDATE`, not `FOR NO KEY UPDATE` (persistence.md "Row locks vs. FK locks"): nothing references `plan_state` by a
 * foreign key, so no FK check's `FOR KEY SHARE` can queue behind (or in front of) the lock, and the row's key is never changed.
 * People and teams are NOT plan state: their writes do not take the lock.
 */
suspend fun <T> R2dbcDatabase.withPlanWrite(block: suspend (revision: Long) -> T): PlanWrite<T> = suspendTransaction(this) {
    val revision = PlanState.select(PlanState.revision)
        .where { PlanState.id eq PLAN_STATE_ID }
        .forUpdate()
        .toList()
        .single()[PlanState.revision]
    val value = block(revision)
    PlanState.update({ PlanState.id eq PLAN_STATE_ID }) {
        it[PlanState.revision] = PlanState.revision + 1L
        it[updatedAt] = nowMillis()
    }
    PlanWrite(value, revision + 1)
}

/**
 * The current revision, read WITHOUT the lock, inside the caller's transaction. A view reads it FIRST and the rows after, in one
 * transaction: a row newer than the revision only makes a client's later PUT answer a conservative 409, never a stale accept.
 */
suspend fun readPlanRevision(): Long =
    PlanState.select(PlanState.revision).where { PlanState.id eq PLAN_STATE_ID }.toList().single()[PlanState.revision]

/**
 * The ranking's revision (V18), read WITHOUT the lock inside the caller's transaction: a view reads it FIRST like [readPlanRevision];
 * inside [withPlanWrite]'s block the same read is exact, because every ranking writer holds the lock.
 */
suspend fun readRankingRevision(): Long =
    PlanState.select(PlanState.rankingRevision).where { PlanState.id eq PLAN_STATE_ID }.toList().single()[PlanState.rankingRevision]

/** Stamps the ranking as written at [revision], the plan revision the enclosing [withPlanWrite] leaves behind (`revision + 1`). */
internal suspend fun stampRankingRevision(revision: Long) {
    PlanState.update({ PlanState.id eq PLAN_STATE_ID }) { it[rankingRevision] = revision }
}
