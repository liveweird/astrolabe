package ch.nokillswit

import ch.nokillswit.planning.CrossTeamAcceptRequest
import ch.nokillswit.planning.STORED_PROPOSAL_FORMAT
import ch.nokillswit.planning.SavedProposalList
import ch.nokillswit.planning.SavedProposalRecord
import ch.nokillswit.planning.SavedProposalState
import ch.nokillswit.planning.SavedProposalState.CHANGED
import ch.nokillswit.planning.SavedProposalState.CURRENT
import ch.nokillswit.planning.SavedProposalSummary
import ch.nokillswit.planning.TeamScheduleBatchItem
import ch.nokillswit.planning.TeamScheduleBatchResponse
import ch.nokillswit.teams.TeamUpdateRequest
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A saved proposal's `state`, derived at read and never stored (`scheduling.md` "Saved proposals"): CURRENT while both scope digests
 * equal the stored token's and no milestone of a run team was rescheduled after the proposal's plan revision; CHANGED otherwise; UNREADABLE
 * for a stored format this server does not read. `can.accept` is the right to run it AND CURRENT.
 */
class SavedProposalStateTest {
    private suspend fun HttpClient.record(id: UInt): SavedProposalRecord {
        val response = get("$SAVED_PATH/$id")
        assertEquals(HttpStatusCode.OK, response.status)
        return response.body()
    }

    private suspend fun SavedWorld.saved(): Pair<UInt, HttpClient> {
        val client = both.client
        val id = client.saveProposal(client.savedRun(pair), pair).body<SavedProposalSummary>().id
        return id to client
    }

    @Test
    fun `current until the run's plan moves - a holiday, a drag - and a change outside the run is still current`() =
        testApplication {
            val s = savedWorld("sst")
            val (id, client) = s.saved()
            assertEquals(CURRENT, client.record(id).state)

            // Outside the run, touching no link of it: still current.
            TestPlan.schedule(s.c1, "2027-06-07", "2027-06-08")
            TestPlan.schedule(TestPlan.milestone(s.w.projectId, s.t3), "2027-06-09", "2027-06-10")
            assertEquals(CURRENT, client.record(id).state, "a change outside the run, off every link of it")

            // A holiday is in the holidays digest; removed again, the proposal reads as before.
            TestHolidays.with("2027-02-03") { assertEquals(CHANGED, client.record(id).state, "a holiday") }
            assertEquals(CURRENT, client.record(id).state, "the holiday removed again")

            // A milestone of a run team is in no digest: its own schedule revision is what notices a colleague's drag.
            val dragRevision = TestPlan.revision()
            TestPlan.schedule(s.b2, "2027-04-07", "2027-04-08")
            assertTrue(TestPlan.revision() > dragRevision)
            val dragged = client.record(id)
            assertEquals(CHANGED, dragged.state, "a milestone of a run team was rescheduled after the proposal's plan revision")
            assertFalse(dragged.can.accept)
            assertTrue(dragged.can.delete, "a changed proposal can still be deleted")
            assertEquals(dragged.proposal, client.record(id).proposal, "the stored run is not rewritten")
        }

    @Test
    fun `a capacity period, a link and a pin of a run team each turn a current proposal into a changed one`() = testApplication {
        val s = savedWorld("ssd")
        for ((label, change) in listOf<Pair<String, suspend () -> Unit>>(
            "a capacity period" to { TestPlan.capacityPeriod(s.t1, "2027-03-01", 5.0) },
            "a link" to { TestPlan.dependency(milestoneRef(s.b2), milestoneRef(s.a1)) },
            "a pin" to { TestPlan.pin(s.b2) },
        )) {
            val (id, client) = s.saved()
            assertEquals(CURRENT, client.record(id).state, "before: $label")
            change()
            assertEquals(CHANGED, client.record(id).state, label)
        }
    }

    @Test
    fun `a renamed team changes the structure digest - and a team that is gone is changed`() = testApplication {
        val s = savedWorld("ssr")
        val (id, client) = s.saved()
        val renamed = TeamUpdateRequest(name = planName("ssr-renamed"), managerPersonId = s.both.personId)
        val rename = s.w.admin.client.putJson("/api/v1/teams/${s.t2}", renamed)
        assertEquals(HttpStatusCode.NoContent, rename.status)
        assertEquals(CHANGED, client.record(id).state, "the team order's tiebreak reads the name, so a rename is in the digest")
    }

    @Test
    fun `accept stays the accept - a CURRENT saved proposal's own revision and hash are accepted, and it then reads as changed`() =
        testApplication {
            val s = savedWorld("ssa")
            val (id, client) = s.saved()
            val record = client.record(id)
            val run = requireNotNull(record.proposal)
            assertTrue(record.can.accept)
            val items = run.teams.flatMap { it.moves }.map { TeamScheduleBatchItem(it.milestoneId, it.to.start, it.to.end) }

            val body = CrossTeamAcceptRequest(run.revision, run.scopeHash, s.pair, items)
            val accept = client.postJson("/api/v1/schedule-proposals/accept", body)
            assertEquals(HttpStatusCode.OK, accept.status)
            assertEquals(items.map { it.milestoneId }, accept.body<TeamScheduleBatchResponse>().accepted)
            val after = client.record(id)
            assertEquals(CHANGED, after.state, "the plan moved under it")
            assertFalse(after.can.accept)
        }

    @Test
    fun `a stored format this server does not read is UNREADABLE - no documents, no accept, still listed and deleted`() = testApplication {
        savedWorld("ssu").assertUnreadableAt(99)
    }

    @Test
    fun `a previous format reads UNREADABLE - a row saved before the check listed its projects is never decoded`() = testApplication {
        assertEquals(4, STORED_PROPOSAL_FORMAT.toInt(), "the check document gained `projects` in format 4: raise this with the next bump")
        savedWorld("ssp").assertUnreadableAt(STORED_PROPOSAL_FORMAT - 1)
    }

    @Test
    fun `a current-format partial selection whose check lacks projects is UNREADABLE, never a 500`() = testApplication {
        val s = savedWorld("ssr")
        val client = s.both.client
        val run = client.savedRun(s.pair)
        val id = client.saveProposal(run, s.pair, selected = listOf(s.a1)).body<SavedProposalSummary>().id
        assertEquals(CURRENT, client.record(id).state)
        TestSavedProposals.execute("UPDATE saved_schedule_proposals SET check_document = check_document - 'projects' WHERE id = $id")
        val record = client.record(id)
        assertEquals(SavedProposalState.UNREADABLE, record.state)
        assertNull(record.proposal)
        assertNull(record.check)
    }

    @Test
    fun `a current-format row whose document lacks projects is UNREADABLE, never a 500`() = testApplication {
        val s = savedWorld("ssq")
        val (id, client) = s.saved()
        assertEquals(CURRENT, client.record(id).state)
        TestSavedProposals.execute("UPDATE saved_schedule_proposals SET document = document - 'projects' WHERE id = $id")
        val record = client.record(id)
        assertEquals(SavedProposalState.UNREADABLE, record.state)
        assertNull(record.proposal)
        assertFalse(record.can.accept)
        assertTrue(client.get(SAVED_PATH).body<SavedProposalList>().items.any { it.id == id })
    }

    private suspend fun SavedWorld.assertUnreadableAt(format: Int) {
        val (id, client) = saved()
        TestSavedProposals.execute("UPDATE saved_schedule_proposals SET format = $format WHERE id = $id")
        val record = client.record(id)
        assertEquals(SavedProposalState.UNREADABLE, record.state, "format $format")
        assertNull(record.proposal)
        assertNull(record.check)
        assertFalse(record.can.accept)
        assertTrue(record.can.delete)
        assertEquals(3, record.selectedMilestoneIds.size, "the ticks are format-independent")
        assertTrue(client.get(SAVED_PATH).body<SavedProposalList>().items.any { it.id == id }, "the list reads no document")
        assertEquals(HttpStatusCode.NoContent, client.delete("$SAVED_PATH/$id").status)
    }
}
