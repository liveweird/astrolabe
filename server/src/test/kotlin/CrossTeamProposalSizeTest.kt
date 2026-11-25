package ch.nokillswit

import ch.nokillswit.planning.CrossTeamProposal
import ch.nokillswit.planning.CrossTeamProposalRequest
import ch.nokillswit.planning.ScheduleProposal
import ch.nokillswit.planning.ScheduleProposalRequest
import ch.nokillswit.users.UserRole
import io.ktor.client.HttpClient
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The size gate of the 1.8 cross-team run (plan decision D2): a run over all 15 teams of a SYNTHETIC plan of the sample's density
 * ([CrossTeamSampleFixture]: 1,000 milestones, about 300 links of which about 30 % cross teams, WIP limits, a capacity step) is at most
 * [MAX_BYTES] bytes uncompressed and answers within [TRIPWIRE_MS] (a loose tripwire, not a budget). The real sample plan is loaded only
 * by `scripts/sample-plan/load.mjs`, which no test touches, so its figure is never gated. The rows are hard-deleted in a `finally`.
 * Prints the size, the passes, `settled` and both times (`ScaleFigures`) for `timeline.md` "Measured figures".
 *
 * The single-team proposal of the 301-milestone team (1.27.0 M2, `POST /teams/{id}/schedule-proposal`, the cell of `timeline.md`
 * "Measured figures" that no test gated) is the second test: its response is at most [SINGLE_TEAM_MAX_BYTES] bytes (the v0.8.0 default
 * budget, recorded then and never asserted; a figure over 130,000 B is a stop-and-report) and both calls answer within [TRIPWIRE_MS].
 */
class CrossTeamProposalSizeTest {
    private val json = Json { ignoreUnknownKeys = true }

    private suspend fun HttpClient.proposeAll(teamIds: List<UInt>): Triple<String, Double, HttpStatusCode> {
        val started = System.nanoTime()
        val response = postJson("/api/v1/schedule-proposals", CrossTeamProposalRequest(ASOF, teamIds))
        val elapsedMs = (System.nanoTime() - started) / NANOS_PER_MILLI
        return Triple(response.bodyAsText(), elapsedMs, response.status)
    }

    @Test
    fun `a 15-team run over the sample's density stays under 600000 bytes and answers within the tripwire`() = testApplication {
        usePostgresTestcontainer()
        val admin = planCaller(planName("size-ad"), UserRole.ADMIN, withPerson = false)
        val prefix = planName("size")
        try {
            val sample = CrossTeamSampleFixture.seed(prefix)
            assertEquals(15, sample.teamIds.size)
            assertEquals(1000, sample.milestones)
            assertTrue(sample.links in 250..300, "the density: ${sample.links} links")
            assertTrue(sample.crossTeamLinks in 60..120, "the density: ${sample.crossTeamLinks} cross-team links")

            val (text, firstMs, status) = admin.client.proposeAll(sample.teamIds)
            assertEquals(HttpStatusCode.OK, status, text.take(300))
            val (_, secondMs, secondStatus) = admin.client.proposeAll(sample.teamIds)
            assertEquals(HttpStatusCode.OK, secondStatus)

            val bytes = text.toByteArray().size
            val run = json.decodeFromString<CrossTeamProposal>(text)
            val moves = run.teams.sumOf { it.moves.size }
            val weeks = run.teams.sumOf { it.weeks.size }
            val violated = run.teams.sumOf { it.dependencies.size }
            val world = "${sample.milestones} milestones (${sample.scheduled} scheduled), " +
                "${sample.links} links (${sample.crossTeamLinks} cross-team)"
            println("scale-figure\tcross-team run, $world\t$moves moves, $weeks week rows, $violated reported links")
            ScaleFigures.printBytes("cross-team run, 15 teams, response", bytes)
            println("scale-figure\tcross-team run, 15 teams, passes\t${run.passes} (settled = ${run.settled})")
            ScaleFigures.print("cross-team run, 15 teams, first request", firstMs)
            ScaleFigures.print("cross-team run, 15 teams, second request", secondMs)

            assertEquals(sample.teamIds.toSet(), run.teams.map { it.teamId }.toSet(), "every requested team has a block")
            assertTrue(bytes <= MAX_BYTES, "the 15-team run is $bytes bytes, over the $MAX_BYTES gate")
            assertTrue(firstMs <= TRIPWIRE_MS, "the first run took $firstMs ms")
            assertTrue(secondMs <= TRIPWIRE_MS, "the second run took $secondMs ms")
        } finally {
            // NonCancellable: a test cancelled by the 60 s limit must still take its rows out of the shared plan.
            withContext(NonCancellable) { CrossTeamSampleFixture.remove(prefix) }
        }
        assertEquals(0, CrossTeamSampleFixture.remaining(prefix), "the synthetic plan is hard-deleted")
    }

    @Test
    fun `a single-team proposal of the 301-milestone team stays under 150000 bytes and answers within the tripwire`() = testApplication {
        usePostgresTestcontainer()
        val admin = planCaller(planName("size1-ad"), UserRole.ADMIN, withPerson = false)
        val prefix = planName("size1")
        try {
            val sample = CrossTeamSampleFixture.seed(prefix)
            val teamId = sample.teamIds.first()
            val milestones = TestPlan.scalar("SELECT count(*) FROM milestones WHERE team_id = $teamId") { it.getInt(1) }
            assertEquals(301, milestones, "the biggest team")

            val (text, firstMs, status) = admin.client.proposeTeam(teamId)
            assertEquals(HttpStatusCode.OK, status, text.take(300))
            val (_, secondMs, secondStatus) = admin.client.proposeTeam(teamId)
            assertEquals(HttpStatusCode.OK, secondStatus)

            val bytes = text.toByteArray().size
            val proposal = json.decodeFromString<ScheduleProposal>(text)
            ScaleFigures.printBytes("single-team proposal, 301 milestones, response", bytes)
            println(
                "scale-figure\tsingle-team proposal, 301 milestones\t${proposal.moves.size} moves, ${proposal.weeks.size} week rows, " +
                    "${proposal.dependencies.size} reported links, ${proposal.unplaced.size} unplaced",
            )
            ScaleFigures.print("single-team proposal, 301 milestones, first request", firstMs)
            ScaleFigures.print("single-team proposal, 301 milestones, second request", secondMs)

            assertEquals(teamId, proposal.teamId)
            assertTrue(bytes <= SINGLE_TEAM_MAX_BYTES, "the single-team proposal is $bytes bytes, over the $SINGLE_TEAM_MAX_BYTES budget")
            assertTrue(firstMs <= TRIPWIRE_MS, "the first proposal took $firstMs ms")
            assertTrue(secondMs <= TRIPWIRE_MS, "the second proposal took $secondMs ms")
        } finally {
            // NonCancellable: a test cancelled by the 60 s limit must still take its rows out of the shared plan.
            withContext(NonCancellable) { CrossTeamSampleFixture.remove(prefix) }
        }
        assertEquals(0, CrossTeamSampleFixture.remaining(prefix), "the synthetic plan is hard-deleted")
    }

    private suspend fun HttpClient.proposeTeam(teamId: UInt): Triple<String, Double, HttpStatusCode> {
        val started = System.nanoTime()
        val response = postJson("/api/v1/teams/$teamId/schedule-proposal", ScheduleProposalRequest(ASOF))
        val elapsedMs = (System.nanoTime() - started) / NANOS_PER_MILLI
        return Triple(response.bodyAsText(), elapsedMs, response.status)
    }

    private companion object {
        const val ASOF = "2026-11-02"
        const val MAX_BYTES = 600_000

        /** The v0.8.0 budget of one team's proposal (recorded then, first asserted in 1.27.0). Over 130,000 B measured: stop and report. */
        const val SINGLE_TEAM_MAX_BYTES = 150_000
        const val TRIPWIRE_MS = 10_000.0
        const val NANOS_PER_MILLI = 1_000_000.0
    }
}
