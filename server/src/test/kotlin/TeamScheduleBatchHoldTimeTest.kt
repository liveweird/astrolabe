package ch.nokillswit

import ch.nokillswit.planning.MAX_BATCH_SCHEDULE_ITEMS
import ch.nokillswit.planning.MilestoneService
import ch.nokillswit.planning.ScheduleProposal
import ch.nokillswit.planning.ScheduleProposalRequest
import ch.nokillswit.planning.TeamScheduleBatchItem
import ch.nokillswit.planning.TeamScheduleBatchRequest
import ch.nokillswit.planning.TeamScheduleBatchResponse
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.withContext
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.r2dbc.select
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The plan-lock hold time of the batch accept at its cap (v1.0.0 checkup): one team with [MAX_BATCH_SCHEDULE_ITEMS] milestones, one
 * `POST /teams/{id}/milestone-schedules` naming every one of them. The request is one plan write under the global `plan_state` lock, so
 * its wall time (client side, over the in-process test engine) is an upper bound of the time every other plan writer waits. The rows are
 * seeded in ONE `INSERT ... SELECT` through [sharedDatabaseForTests] (not 1,000 POSTs) on a throwaway chain and removed again, so the
 * shared suite state is as it was; the request itself is the only plan write the test makes (one revision bump per batch). It prints
 * the request time of the first batch (cold for this JVM when no earlier class ran one) and of a second, warm one
 * (`ScaleFigures`) and asserts a loose tripwire on both.
 *
 * It also prints the time of the accept's LOOK-AGAIN path (1.13.1, `planning-model.md`): a proposal over the same team (with a capacity
 * period), a far-off holiday added after it, then the accept of its moves with the proposal's token - the holidays part differs, so
 * the kernel runs once under the plan lock before the write. No gate: the figure is the cost of that rare path at the batch cap.
 */
class TeamScheduleBatchHoldTimeTest {
    private val monday = LocalDate.parse("2027-02-01")

    /** `Mon..Fri` of week `i % 200` (plus [shiftWeeks]) for the i-th milestone: every span holds working days. */
    private fun items(ids: List<UInt>, shiftWeeks: Long) = ids.mapIndexed { i, id ->
        val start = monday.plusWeeks(i % WEEKS + shiftWeeks)
        TeamScheduleBatchItem(id, start.toString(), start.plusDays(4).toString())
    }

    private suspend fun HttpClient.batch(
        teamId: UInt,
        expected: Long,
        items: List<TeamScheduleBatchItem>,
    ): Pair<TeamScheduleBatchResponse, Double> {
        val started = System.nanoTime()
        val response = postJson("/api/v1/teams/$teamId/milestone-schedules", TeamScheduleBatchRequest(expected, items))
        val elapsedMs = (System.nanoTime() - started) / NANOS_PER_MILLI
        assertEquals(HttpStatusCode.OK, response.status)
        return response.body<TeamScheduleBatchResponse>() to elapsedMs
    }

    /** Prints the wall time of an accept that takes the look-again path: the proposal's own moves, its token, a holiday added since it. */
    private suspend fun lookAgain(client: HttpClient, teamId: UInt) {
        TestPlan.capacityPeriod(teamId, "2027-01-04", 10.0)
        val request = ScheduleProposalRequest("2027-01-31")
        val proposal: ScheduleProposal = client.postJson("/api/v1/teams/$teamId/schedule-proposal", request).body()
        assertTrue(proposal.moves.isNotEmpty(), "the capacity period gives the team something to move")
        val moves = proposal.moves.map { TeamScheduleBatchItem(it.milestoneId, it.to.start, it.to.end) }
        TestHolidays.with("2045-08-16") {
            val started = System.nanoTime()
            val response = client.postJson(
                "/api/v1/teams/$teamId/milestone-schedules",
                TeamScheduleBatchRequest(proposal.revision, moves, proposal.scopeHash),
            )
            val elapsedMs = (System.nanoTime() - started) / NANOS_PER_MILLI
            assertEquals(HttpStatusCode.OK, response.status, "a far-off holiday changes no accepted date")
            assertEquals(moves.map { it.milestoneId }, response.body<TeamScheduleBatchResponse>().accepted)
            ScaleFigures.print("batch accept look-again path, ${moves.size} items (a holiday added since the proposal)", elapsedMs)
        }
    }

    private suspend fun seedMilestones(projectId: UInt, teamId: UInt, prefix: String): List<UInt> {
        suspendTransaction(sharedDatabaseForTests()) {
            exec(
                "INSERT INTO milestones (project_id, team_id, \"name\", estimate_md, schedule_revision, created_at, updated_at) " +
                    "SELECT $projectId, $teamId, '$prefix-' || g, 2, 0, 1, 1 FROM generate_series(1, $MAX_BATCH_SCHEDULE_ITEMS) g",
            )
        }
        val milestones = MilestoneService.Milestones
        return suspendTransaction(sharedDatabaseForTests()) {
            milestones.select(milestones.id).where { milestones.teamId eq teamId }.map { it[milestones.id].value }.toList()
        }.sorted()
    }

    @Test
    fun `a batch of 1000 milestones holds the plan lock for a small fraction of the tripwire`() = testApplication {
        usePostgresTestcontainer()
        val admin = planCaller(planName("hold-ad"), UserRole.ADMIN, withPerson = false)
        val owner = TestPeople.seed(planName("hold-owner"))
        val streamId = TestPlan.workStream(owner)
        val programId = TestPlan.program(streamId, owner)
        val projectId = TestPlan.project(programId, owner)
        val teamId = TestTeams.seed(planName("hold-team"))
        try {
            val ids = seedMilestones(projectId, teamId, planName("hold-ms"))
            assertEquals(MAX_BATCH_SCHEDULE_ITEMS, ids.size)

            val (first, firstMs) = admin.client.batch(teamId, TestPlan.revision(), items(ids, 0))
            assertEquals(ids, first.accepted)
            assertTrue(first.skipped.isEmpty())
            val (second, secondMs) = admin.client.batch(teamId, first.revision, items(ids, 1))
            assertEquals(ids, second.accepted)
            assertEquals(first.revision + 1, second.revision)

            ScaleFigures.print("batch accept $MAX_BATCH_SCHEDULE_ITEMS items, first request", firstMs)
            ScaleFigures.print("batch accept $MAX_BATCH_SCHEDULE_ITEMS items, second request", secondMs)
            assertTrue(firstMs <= TRIPWIRE_MS, "the first batch took $firstMs ms")
            assertTrue(secondMs <= TRIPWIRE_MS, "the second batch took $secondMs ms")
            lookAgain(admin.client, teamId)
        } finally {
            // NonCancellable: a test cancelled by the 60 s limit must still take its 1,000 rows out of the shared plan.
            withContext(NonCancellable) {
                suspendTransaction(sharedDatabaseForTests()) { exec("DELETE FROM milestones WHERE team_id = $teamId") }
                for (path in listOf("projects/$projectId", "programs/$programId", "work-streams/$streamId", "teams/$teamId")) {
                    admin.client.delete("/api/v1/$path")
                }
            }
        }
        assertEquals(0, TestPlan.scalar("SELECT count(*) FROM milestones WHERE team_id = $teamId") { it.getInt(1) }, "the rows are gone")
        assertEquals(
            0,
            TestPlan.scalar("SELECT count(*) FROM work_streams WHERE id = $streamId AND NOT marked_as_deleted") { it.getInt(1) },
            "the throwaway chain is soft-deleted",
        )
    }

    private companion object {
        const val WEEKS = 200L
        const val NANOS_PER_MILLI = 1_000_000.0
        const val TRIPWIRE_MS = 5_000.0
    }
}
