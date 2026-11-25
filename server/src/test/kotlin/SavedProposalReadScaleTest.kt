package ch.nokillswit

import ch.nokillswit.planning.CrossTeamProposal
import ch.nokillswit.planning.CrossTeamProposalRequest
import ch.nokillswit.planning.SavedProposalRecord
import ch.nokillswit.planning.SavedProposalState
import ch.nokillswit.planning.SavedProposalSummary
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The read of a saved cross-team proposal at 15 teams (1.27.0 M2; the saved-proposal read of `timeline.md` "Measured figures").
 * [CrossTeamSampleFixture] seeds the sample plan's density (1,000 milestones, about 300 links, 15 teams). ONE run over all 15 teams is
 * saved twice as ADMIN: with every move ticked (its `check` is null, the proposal's own post-check applies) and with half of them
 * (the stored `check` document too). Each record is then read through the shape-checked client (state `CURRENT`, the counts) and
 * sized (plain, gzip) and timed through the bare one (median of [SCALE_RUNS] warm reads). It prints the save's time (the server's own
 * re-computation of the run plus the insert, through the shape-checked client) and what the row stores: `pg_column_size` of the
 * `document` (what the database keeps, compressed past its TOAST threshold) and the octets of its text.
 *
 * Gates: the fully ticked record is at most [MAX_RECORD_BYTES] bytes uncompressed (the run's own 472,470 B plus the ticked ids and
 * the summary); every save and every read median under [TRIPWIRE_MS] (a loose tripwire, never the machine's speed). The half-ticked
 * record's size is printed only. The table is GLOBAL (the newest [ch.nokillswit.planning.MAX_SAVED_PROPOSALS] are kept and any save evicts
 * the oldest) and only `SavedProposal*Test` classes and one `PlanStateTest` case write it (one class at a time in a fork), so this class
 * is named like them, empties the table before it saves and again in its `finally`, together with the sample. Figures: a run of this
 * class ALONE.
 */
class SavedProposalReadScaleTest {
    private val json = Json { ignoreUnknownKeys = true }

    private class Saved(val summary: SavedProposalSummary, val saveMs: Double)

    private suspend fun ScaleCaller.runAll(teamIds: List<UInt>): CrossTeamProposal {
        val response = conformant.postJson("/api/v1/schedule-proposals", CrossTeamProposalRequest(AS_OF, teamIds))
        assertEquals(HttpStatusCode.OK, response.status)
        return response.body()
    }

    private suspend fun ScaleCaller.save(run: CrossTeamProposal, teamIds: List<UInt>, selected: List<UInt>, name: String): Saved {
        val started = System.nanoTime()
        val response = conformant.saveProposal(run, teamIds, selected, name, asOf = AS_OF)
        val elapsedMs = (System.nanoTime() - started) / NANOS_PER_MILLI
        val text = response.bodyAsText()
        assertEquals(HttpStatusCode.Created, response.status, text.take(300))
        return Saved(json.decodeFromString<SavedProposalSummary>(text), elapsedMs)
    }

    /** Reads saved proposal [saved] twice over: the shape and the state through the shape-checked client, the size and time bare. */
    private suspend fun ScaleCaller.read(label: String, saved: Saved, ticked: Int): DocumentReading {
        val path = "$SAVED_PATH/${saved.summary.id}"
        val record = conformant.get(path).also { assertEquals(HttpStatusCode.OK, it.status) }.body<SavedProposalRecord>()
        assertEquals(SavedProposalState.CURRENT, record.state, "$label: nothing moved since the save")
        assertEquals(ticked, record.selectedCount)
        assertEquals(ticked, record.selectedMilestoneIds.size)
        assertNotNull(record.proposal, "$label: the stored run")
        if (ticked == record.moveCount) {
            assertNull(record.check, "$label: every move ticked, no stored check")
        } else {
            assertNotNull(record.check, "$label: a partial selection stores its own check")
        }
        val reading = bare.readDocument(path)
        // What the row keeps: the compressed document (TOAST), its text, the stored check and the ticked ids.
        val stored = TestSavedProposals.scalar(
            saved.summary.id,
            "pg_column_size(document), octet_length(document::text), coalesce(pg_column_size(check_document), 0), pg_column_size(selected)",
        ) { listOf(it.getInt(1), it.getInt(2), it.getInt(3), it.getInt(4)) }
        ScaleFigures.print("saved proposal ($label), save request", saved.saveMs)
        ScaleFigures.printBytes("saved proposal ($label), read size", reading.size)
        ScaleFigures.printBytes("saved proposal ($label), read gzip", reading.gzip)
        ScaleFigures.printSeries("saved proposal ($label), read", reading.timings)
        println(
            "scale-figure\tsaved proposal ($label), stored row\tdocument ${stored[0]} B in the database, ${stored[1]} B of text, " +
                "check ${stored[2]} B, selected ${stored[3]} B",
        )
        assertTrue(saved.saveMs <= TRIPWIRE_MS, "$label: the save took ${saved.saveMs} ms")
        assertTrue(reading.median <= TRIPWIRE_MS, "$label: the read's median is ${reading.median} ms")
        return reading
    }

    @Test
    fun `a saved 15-team proposal reads back current inside its byte gate and tripwires`() = testApplication {
        usePostgresTestcontainer()
        val admin = scaleAdmin("spscale-ad")
        val prefix = planName("spscale")
        TestSavedProposals.clear()
        try {
            val sample = CrossTeamSampleFixture.seed(prefix)
            assertEquals(15, sample.teamIds.size)
            val run = admin.runAll(sample.teamIds)
            val moves = run.moveIds()
            assertTrue(moves.size >= 2, "the run proposes ${moves.size} moves: enough to tick half of them")

            val fullySaved = admin.save(run, sample.teamIds, moves, "Scale, every move ticked")
            val halfSaved = admin.save(run, sample.teamIds, moves.take(moves.size / 2), "Scale, half ticked")
            assertEquals(moves.size, fullySaved.summary.moveCount)
            println("scale-figure\tsaved proposal, the run\t${moves.size} moves, ${run.passes} passes (settled = ${run.settled})")

            val full = admin.read("every move ticked", fullySaved, moves.size)
            admin.read("half ticked", halfSaved, moves.size / 2)
            assertTrue(full.size <= MAX_RECORD_BYTES, "the fully ticked record is ${full.size} bytes, over the $MAX_RECORD_BYTES gate")
        } finally {
            // NonCancellable: a test cancelled by the 60 s limit must still empty the shared table and take the sample out.
            withContext(NonCancellable) {
                try {
                    TestSavedProposals.clear()
                } finally {
                    CrossTeamSampleFixture.remove(prefix)
                }
            }
        }
        assertEquals(0, TestSavedProposals.count(), "the table is empty again")
        assertEquals(0, CrossTeamSampleFixture.remaining(prefix), "the synthetic plan is hard-deleted")
    }

    private companion object {
        /** The size test's day (a Monday before the sample's first dated milestone), so the run is the 472,470 B one of `timeline.md`. */
        const val AS_OF = "2026-11-02"
        const val NANOS_PER_MILLI = 1_000_000.0

        /** The fully ticked record: the run's 472,470 B plus the summary and the ticked ids. Over 620,000 B measured: stop and report. */
        const val MAX_RECORD_BYTES = 650_000

        /** A LOOSE tripwire on every save and every read median (the stop line, 500 ms for the read, is in `timeline.md`, not asserted). */
        const val TRIPWIRE_MS = 10_000.0
    }
}
