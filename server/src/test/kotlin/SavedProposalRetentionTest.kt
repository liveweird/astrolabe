package ch.nokillswit

import ch.nokillswit.planning.MAX_SAVED_PROPOSALS
import ch.nokillswit.planning.SavedProposalList
import ch.nokillswit.planning.SavedProposalSummary
import ch.nokillswit.users.UserRole
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The newest [MAX_SAVED_PROPOSALS] proposals are kept (`scheduling.md` "Saved proposals"): the 21st save removes the GLOBALLY oldest,
 * whoever saved it, in its own transaction, and saves serialize on a table lock taken BEFORE the snapshot so two of them never prune
 * one row. The table is GLOBAL: these classes (`SavedProposal*Test`, with the one `PlanStateTest` case that saves and deletes its own
 * row) are its only users and run one after another in a fork, so a test that counts or fills it empties it first
 * (`test-fixtures.md`). A login saves 10 a minute, so the many saves here go through [callerPool].
 */
class SavedProposalRetentionTest {
    @Test
    fun `any save evicts the globally oldest - a one-team manager's 21st slot takes another manager's row - and the audit says which`() =
        testApplication {
            val s = savedWorld("sr")
            TestSavedProposals.clear()
            val savers = callerPool("sr-admin")
            val run = s.both.client.savedRun(s.pair)
            val oldest = s.both.client.saveProposal(run, s.pair, name = "Oldest").body<SavedProposalSummary>().id
            val later = List(MAX_SAVED_PROPOSALS - 1) {
                val response = savers.next().client.saveProposal(run, s.pair, name = "Kept $it")
                assertEquals(HttpStatusCode.Created, response.status)
                response.body<SavedProposalSummary>().id
            }
            assertEquals(MAX_SAVED_PROPOSALS, TestSavedProposals.count(), "twenty are kept without a prune")

            // The delete guard stops a TARGETED delete; it does not shield the row from the cap.
            assertEquals(HttpStatusCode.Forbidden, s.m3.client.delete("$SAVED_PATH/$oldest").status)
            val own = TestPlan.milestone(s.w.projectId, s.t3) // unscheduled: certainly a move of a run over team 3
            val m3Run = s.m3.client.savedRun(listOf(s.t3))
            assertTrue(own in m3Run.moveIds())

            withAuditCapture { capture ->
                val twentyFirst = s.m3.client.saveProposal(m3Run, listOf(s.t3), name = "The 21st")
                assertEquals(HttpStatusCode.Created, twentyFirst.status)
                val newest = twentyFirst.body<SavedProposalSummary>().id
                val saved = capture.awaitEvent { it.message == "schedule_proposal.saved" && it.hasKeyValue("name", "The 21st") }
                val line = assertNotNull(saved)
                assertTrue(line.hasKeyValue("byUserId", s.m3.userId.toLong()))
                assertTrue(line.hasKeyValue("prunedIds", "$oldest"), "the oldest of the table, another manager's, and only it")
                assertEquals(MAX_SAVED_PROPOSALS, TestSavedProposals.count())
                assertFalse(TestSavedProposals.exists(oldest))
                assertEquals(HttpStatusCode.NotFound, s.both.client.get("$SAVED_PATH/$oldest").status)
                val listed = s.w.stranger.client.get(SAVED_PATH).body<SavedProposalList>().items.map { it.id }
                assertEquals((later + newest).reversed(), listed, "newest first")
            }
        }

    @Test
    fun `the 20th save prunes nothing, and a delete frees a slot so the next one prunes nothing either`() = testApplication {
        val s = savedWorld("srn")
        TestSavedProposals.clear()
        val savers = callerPool("srn-admin")
        val run = s.both.client.savedRun(s.pair)
        withAuditCapture { capture ->
            val ids = List(MAX_SAVED_PROPOSALS) {
                val response = savers.next().client.saveProposal(run, s.pair, name = "Fill $it")
                assertEquals(HttpStatusCode.Created, response.status)
                response.body<SavedProposalSummary>().id
            }
            val lines = capture.events.filter { it.message == "schedule_proposal.saved" }
            assertEquals(MAX_SAVED_PROPOSALS, lines.size)
            assertTrue(lines.all { it.hasKeyValue("prunedIds", "") }, "up to the 20th nothing is pruned")
            assertEquals(MAX_SAVED_PROPOSALS, TestSavedProposals.count())

            assertEquals(HttpStatusCode.NoContent, s.both.client.delete("$SAVED_PATH/${ids[1]}").status)
            savers.next().client.saveProposal(run, s.pair, name = "No prune")
            val line = assertNotNull(capture.awaitEvent { it.message == "schedule_proposal.saved" && it.hasKeyValue("name", "No prune") })
            assertTrue(line.hasKeyValue("prunedIds", ""))
            assertEquals(MAX_SAVED_PROPOSALS, TestSavedProposals.count())
        }
    }

    @Test
    fun `saves at the cap that race each other all succeed and leave exactly the newest twenty`() = testApplication {
        val s = savedWorld("srr")
        TestSavedProposals.clear()
        val savers = callerPool("srr-admin")
        val run = s.both.client.savedRun(s.pair)
        repeat(MAX_SAVED_PROPOSALS) { assertEquals(HttpStatusCode.Created, savers.next().client.saveProposal(run, s.pair).status) }
        val racers = List(4) { savers.next() }
        val raced = coroutineScope {
            racers.mapIndexed { n, caller -> async { caller.client.saveProposal(run, s.pair, name = "Race $n") } }.awaitAll()
        }
        assertEquals(List(4) { HttpStatusCode.Created }, raced.map { it.status }, "no serialization failure")
        assertEquals(MAX_SAVED_PROPOSALS, TestSavedProposals.count())
        val newest = raced.map { it.body<SavedProposalSummary>().id }
        val listed = s.both.client.get(SAVED_PATH).body<SavedProposalList>().items.map { it.id }
        assertTrue(listed.containsAll(newest) && listed.size == MAX_SAVED_PROPOSALS, "the racers are the newest")
    }

    @Test
    fun `a save waits for the table lock - before its snapshot - and readers do not`() = testApplication {
        val s = savedWorld("srl")
        val run = s.both.client.savedRun(s.pair)
        PostgresTestSupport.connect().use { raw ->
            raw.autoCommit = false
            raw.createStatement().use { it.execute("LOCK TABLE saved_schedule_proposals IN SHARE ROW EXCLUSIVE MODE") }
            try {
                coroutineScope {
                    val saving = async { s.both.client.saveProposal(run, s.pair, name = "Waits") }
                    awaitLockWait("saved_schedule_proposals")
                    assertEquals(HttpStatusCode.OK, s.both.client.get(SAVED_PATH).status, "a read is not blocked by the save lock")
                    raw.rollback()
                    assertEquals(HttpStatusCode.Created, saving.await().status)
                }
            } finally {
                raw.rollback()
            }
        }
    }

    @Test
    fun `a manager cleared while the save waits for the table lock is refused 403 by the guard re-run inside - nothing stored`() =
        testApplication {
            val s = savedWorld("srg")
            TestSavedProposals.clear()
            val run = s.both.client.savedRun(s.pair)
            val admin = planCaller("srg-admin", UserRole.ADMIN, withPerson = false)
            val revision = TestPlan.revision()
            val held = PostgresTestSupport.connect().use { raw ->
                raw.autoCommit = false
                raw.createStatement().use { it.execute("LOCK TABLE saved_schedule_proposals IN SHARE ROW EXCLUSIVE MODE") }
                try {
                    coroutineScope {
                        // It passes the route's outer guard (the manager is still there), then waits for the table lock.
                        val saving = async { s.both.client.saveProposal(run, s.pair, name = "Cleared") }
                        awaitLockWait("saved_schedule_proposals")
                        raw.createStatement().use { it.executeUpdate("UPDATE teams SET manager_person_id = NULL WHERE id = ${s.t2}") }
                        raw.commit()
                        saving.await()
                    }
                } finally {
                    raw.rollback()
                }
            }
            assertEquals(HttpStatusCode.Forbidden, held.status)
            assertEquals(0, TestSavedProposals.count(), "nothing stored")
            assertEquals(revision, TestPlan.revision())
            assertEquals(HttpStatusCode.Created, admin.client.saveProposal(run, s.pair).status, "ADMIN needs no manager")
        }
}
