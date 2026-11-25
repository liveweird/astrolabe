package ch.nokillswit

import ch.nokillswit.planning.ProgramCreateRequest
import ch.nokillswit.planning.ProgramMoveRequest
import ch.nokillswit.planning.WorkStreamCreateRequest
import ch.nokillswit.planning.WorkStreamUpdateRequest
import io.ktor.client.request.delete
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import java.sql.SQLException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The lifecycle half of the shared plan order (V34), beside `PlanOrderTest`'s API matrix: the positions staying dense when a work
 * stream or program leaves its list (a delete, a move), a create or a close writing nothing, the DEFERRABLE position constraints, two
 * PUTs racing for one revision, the chain and guard re-run under the plan lock, and a stale row from a rolled-back build being repaired
 * by the next PUT. The work stream order is ONE global list, so each test empties it first (exact positions) and last (the shared state).
 */
class PlanOrderLifecycleTest {
    private val ok = HttpStatusCode.OK
    private val noContent = HttpStatusCode.NoContent

    private fun dense(ids: List<UInt>): List<Pair<Int, UInt>> = ids.mapIndexed { index, id -> index + 1 to id }

    private fun rawSql(sql: String) = PostgresTestSupport.connect().use { c -> c.createStatement().use { it.executeUpdate(sql) } }

    @Test
    fun `a work stream delete takes it out of the order and keeps the positions dense - first, middle and last`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("wslife")
        val owner = w.streamOwner.personId!!
        val (s1, s2, s3) = List(3) { TestPlan.workStream(owner) }
        val (s4, s5) = List(2) { TestPlan.workStream(owner) }
        val unlisted = TestPlan.workStream(owner)
        TestPlan.resetWorkStreamOrder()
        try {
            TestPlan.workStreamOrder(listOf(s1, s2, s3, s4, s5))
            val stamped = TestPlan.workStreamOrderRevision()
            val admin = w.admin.client
            val before = TestPlan.revision()
            assertEquals(noContent, admin.delete("/api/v1/work-streams/$s3").status)
            assertEquals(dense(listOf(s1, s2, s4, s5)), TestPlan.workStreamOrderRows())
            assertEquals(before + 1, TestPlan.revision(), "the delete and its compaction are ONE plan write")
            assertEquals(noContent, admin.delete("/api/v1/work-streams/$s1").status)
            assertEquals(dense(listOf(s2, s4, s5)), TestPlan.workStreamOrderRows())
            assertEquals(noContent, admin.delete("/api/v1/work-streams/$s5").status)
            assertEquals(dense(listOf(s2, s4)), TestPlan.workStreamOrderRows())
            // An unlisted stream's delete leaves the order alone; a removal never bumps the order revision.
            assertEquals(noContent, admin.delete("/api/v1/work-streams/$unlisted").status)
            assertEquals(dense(listOf(s2, s4)), TestPlan.workStreamOrderRows())
            assertEquals(stamped, TestPlan.workStreamOrderRevision())
            // The survivors can be reordered at the stored revision: the compaction did not stale them.
            assertEquals(ok, admin.putWorkStreamOrder(stamped, listOf(s4, s2)).status)
            assertEquals(dense(listOf(s4, s2)), TestPlan.workStreamOrderRows())
        } finally {
            TestPlan.resetWorkStreamOrder()
        }
    }

    @Test
    fun `a program delete and a move take it out of its stream's order - dense, the target unlisted, a no-op move changes nothing`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pglife")
            val owner = w.programOwner.personId!!
            val target = TestPlan.workStream(w.streamOwner.personId!!)
            val (p1, p2, p3) = List(3) { TestPlan.program(w.streamId, owner) }
            val (p4, p5) = List(2) { TestPlan.program(w.streamId, owner) }
            val unlisted = TestPlan.program(w.streamId, owner)
            val (q1, q2) = List(2) { TestPlan.program(target, owner) }
            TestPlan.programOrder(w.streamId, listOf(p1, p2, p3, p4, p5))
            TestPlan.programOrder(target, listOf(q1, q2))
            val stamped = TestPlan.programOrderRevision(w.streamId)
            val targetStamped = TestPlan.programOrderRevision(target)
            val admin = w.admin.client

            val before = TestPlan.revision()
            assertEquals(noContent, admin.delete("/api/v1/programs/$p3").status)
            assertEquals(dense(listOf(p1, p2, p4, p5)), TestPlan.programOrderRows(w.streamId))
            assertEquals(before + 1, TestPlan.revision(), "the delete and its compaction are ONE plan write")
            // A move out of the front: the source closes up, the target is untouched and does NOT list the newcomer.
            assertEquals(noContent, admin.postJson("/api/v1/programs/$p1/move", ProgramMoveRequest(target)).status)
            assertEquals(dense(listOf(p2, p4, p5)), TestPlan.programOrderRows(w.streamId))
            assertEquals(dense(listOf(q1, q2)), TestPlan.programOrderRows(target))
            assertEquals(emptyList(), TestPlan.programOrderRows(target).filter { it.second == p1 }, "unlisted in the target")
            // A move out of the end, then a delete of the first of the rest.
            assertEquals(noContent, admin.postJson("/api/v1/programs/$p5/move", ProgramMoveRequest(target)).status)
            assertEquals(dense(listOf(p2, p4)), TestPlan.programOrderRows(w.streamId))
            assertEquals(noContent, admin.delete("/api/v1/programs/$p2").status)
            assertEquals(dense(listOf(p4)), TestPlan.programOrderRows(w.streamId))
            // A move to the current stream writes nothing, so the program stays listed.
            assertEquals(noContent, admin.postJson("/api/v1/programs/$p4/move", ProgramMoveRequest(w.streamId)).status)
            assertEquals(dense(listOf(p4)), TestPlan.programOrderRows(w.streamId))
            // An unlisted program's delete and move leave every list alone; a removal never bumps a program order revision.
            assertEquals(noContent, admin.postJson("/api/v1/programs/$unlisted/move", ProgramMoveRequest(target)).status)
            assertEquals(noContent, admin.delete("/api/v1/programs/$unlisted").status)
            assertEquals(dense(listOf(p4)), TestPlan.programOrderRows(w.streamId))
            assertEquals(dense(listOf(q1, q2)), TestPlan.programOrderRows(target))
            assertEquals(stamped, TestPlan.programOrderRevision(w.streamId))
            assertEquals(targetStamped, TestPlan.programOrderRevision(target))
            val gone = TestPlan.scalar("SELECT count(*) FROM program_orders WHERE program_id IN ($p1, $p2, $p3, $p5, $unlisted)") {
                it.getInt(1)
            }
            assertEquals(0, gone)
            // The moved program can be listed by its new stream, and the source's survivors reordered at the stored revision.
            assertEquals(ok, w.streamOwner.client.putProgramOrder(target, requireNotNull(targetStamped), listOf(p1, q2, q1, p5)).status)
            assertEquals(dense(listOf(p1, q2, q1, p5)), TestPlan.programOrderRows(target))
            assertEquals(ok, w.streamOwner.client.putProgramOrder(w.streamId, requireNotNull(stamped), listOf(p4)).status)
        }

    @Test
    fun `creating a stream or a program, and closing or reopening a stream, write no order row and no order revision`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("nolife")
        val owner = w.streamOwner.personId!!
        val listed = TestPlan.workStream(owner)
        val listedProgram = TestPlan.program(listed, owner)
        TestPlan.resetWorkStreamOrder()
        try {
            TestPlan.workStreamOrder(listOf(listed))
            TestPlan.programOrder(listed, listOf(listedProgram))
            val streamRevision = TestPlan.workStreamOrderRevision()
            val programRevision = TestPlan.programOrderRevision(listed)
            val admin = w.admin.client

            val created = admin.postJson("/api/v1/work-streams", WorkStreamCreateRequest(planName("nl-ws"), null, owner, "2026-01-01"))
            assertEquals(HttpStatusCode.Created, created.status)
            val programBody = ProgramCreateRequest(planName("nl-pg"), null, owner)
            val createdProgram = admin.postJson("/api/v1/work-streams/$listed/programs", programBody)
            assertEquals(HttpStatusCode.Created, createdProgram.status)
            val body = WorkStreamUpdateRequest(planName("nl-closed"), null, owner, "2026-01-01", "2026-12-31")
            assertEquals(noContent, admin.putJson("/api/v1/work-streams/$listed", body).status, "close")
            assertEquals(noContent, admin.putJson("/api/v1/work-streams/$listed", body.copy(endDate = null)).status, "reopen")

            assertEquals(dense(listOf(listed)), TestPlan.workStreamOrderRows(), "nothing joins the order: the newcomer is unlisted")
            assertEquals(dense(listOf(listedProgram)), TestPlan.programOrderRows(listed))
            assertEquals(streamRevision, TestPlan.workStreamOrderRevision())
            assertEquals(programRevision, TestPlan.programOrderRevision(listed))
        } finally {
            TestPlan.resetWorkStreamOrder()
        }
    }

    @Test
    fun `the position constraints are deferrable - a swap passes, a duplicate fails only at commit, the CHECK at once`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("plsql")
        val owner = w.streamOwner.personId!!
        val (s1, s2, s3) = List(3) { TestPlan.workStream(owner) }
        val (a, b, c) = List(3) { TestPlan.program(w.streamId, owner) }
        TestPlan.resetWorkStreamOrder()
        try {
            TestPlan.workStreamOrder(listOf(s1, s2, s3))
            TestPlan.programOrder(w.streamId, listOf(a, b, c))
            for (name in listOf("uq_work_stream_orders_position", "uq_program_orders_position")) {
                val sql = "SELECT condeferrable AND condeferred FROM pg_constraint WHERE conname = '$name'"
                val deferrable = TestPlan.scalar(sql) { it.getBoolean(1) }
                assertTrue(deferrable, "$name is DEFERRABLE INITIALLY DEFERRED")
            }
            val tables = listOf(
                Triple("work_stream_orders", "work_stream_id", Triple(s1, s2, s3)),
                Triple("program_orders", "program_id", Triple(a, b, c)),
            )
            for ((table, key, ids) in tables) {
                val (x, y, z) = ids
                PostgresTestSupport.connect().use { c1 ->
                    c1.autoCommit = false
                    val swap = "UPDATE $table SET position = CASE $key WHEN $x THEN 2 WHEN $y THEN 1 END WHERE $key IN ($x, $y)"
                    c1.createStatement().use { it.executeUpdate(swap) }
                    c1.commit()
                    c1.createStatement().use { it.executeUpdate("UPDATE $table SET position = 1 WHERE $key = $z") }
                    assertEquals("23505", assertFailsWith<SQLException> { c1.commit() }.sqlState, table)
                    c1.rollback()
                    val check = assertFailsWith<SQLException> {
                        c1.createStatement().use { it.executeUpdate("UPDATE $table SET position = 0 WHERE $key = $z") }
                    }
                    assertEquals("23514", check.sqlState, table)
                    c1.rollback()
                }
            }
            assertEquals(dense(listOf(s2, s1, s3)), TestPlan.workStreamOrderRows())
            assertEquals(dense(listOf(b, a, c)), TestPlan.programOrderRows(w.streamId))
        } finally {
            TestPlan.resetWorkStreamOrder()
        }
    }

    @Test
    fun `two PUTs racing with the same expectedRevision - exactly one wins and the other is the stale 409, per list`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("plrace")
        val owner = w.streamOwner.personId!!
        val (s1, s2, s3) = List(3) { TestPlan.workStream(owner) }
        val (a, b, c) = List(3) { TestPlan.program(w.streamId, owner) }
        TestPlan.resetWorkStreamOrder()
        try {
            TestPlan.workStreamOrder(listOf(s1, s2, s3))
            TestPlan.programOrder(w.streamId, listOf(a, b, c))
            val streamOrders = listOf(listOf(s3, s2, s1), listOf(s2, s3, s1))
            val programOrders = listOf(listOf(c, b, a), listOf(b, c, a))
            val streamRevision = TestPlan.workStreamOrderRevision()
            val programRevision = requireNotNull(TestPlan.programOrderRevision(w.streamId))
            val plan = TestPlan.revision()
            val statuses = PostgresTestSupport.connect().use { raw ->
                raw.autoCommit = false
                raw.createStatement().use { it.executeQuery("SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE").close() }
                try {
                    coroutineScope {
                        val streamCalls = streamOrders.map { ids -> async { w.admin.client.putWorkStreamOrder(streamRevision, ids) } }
                        val programCalls = programOrders.map { ids ->
                            async { w.streamOwner.client.putProgramOrder(w.streamId, programRevision, ids) }
                        }
                        awaitLockWait("plan_state", waiters = 4)
                        raw.rollback()
                        streamCalls.map { it.await().status } to programCalls.map { it.await().status }
                    }
                } finally {
                    raw.rollback()
                }
            }
            val (streamStatuses, programStatuses) = statuses
            assertEquals(listOf(ok, HttpStatusCode.Conflict), streamStatuses.sortedBy { it.value })
            assertEquals(listOf(ok, HttpStatusCode.Conflict), programStatuses.sortedBy { it.value })
            assertEquals(plan + 2, TestPlan.revision(), "only the two winners bumped")
            assertEquals(dense(streamOrders[streamStatuses.indexOf(ok)]), TestPlan.workStreamOrderRows(), "the winner's list, whole")
            val programWinner = dense(programOrders[programStatuses.indexOf(ok)])
            assertEquals(programWinner, TestPlan.programOrderRows(w.streamId), "the winner's list, whole")
        } finally {
            TestPlan.resetWorkStreamOrder()
        }
    }

    @Test
    fun `a work stream deleted while the PUT waits at the plan lock is 404 - no state row, no bump, no audit`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("plheld404")
        val streamId = TestPlan.workStream(w.streamOwner.personId!!)
        val revision = TestPlan.revision()
        withAuditCapture { capture ->
            val response = requestHeldAtPlanLock(
                { w.streamOwner.client.putProgramOrder(streamId, revision, emptyList()) },
                { it.exec("UPDATE work_streams SET marked_as_deleted = TRUE WHERE id = ?", streamId.toInt()) },
            )
            assertEquals(HttpStatusCode.NotFound, response.status, "the outer check passed; the chain re-read under the plan lock did not")
            val stream = streamId.toLong()
            assertTrue(capture.events.none { it.message == "work_stream.program_order_changed" && it.hasKeyValue("workStreamId", stream) })
        }
        assertNull(TestPlan.programOrderRevision(streamId), "no state row for a stream that went away")
        assertEquals(revision, TestPlan.revision())
    }

    @Test
    fun `an owner demoted while the PUT waits at the plan lock is refused - 403, nothing written, no bump`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("plheld403")
        val (b) = List(1) { TestPlan.program(w.streamId, w.programOwner.personId!!) }
        val a = w.programId
        TestPlan.programOrder(w.streamId, listOf(a, b))
        val revision = TestPlan.revision()
        withAuditCapture { capture ->
            val response = requestHeldAtPlanLock(
                { w.streamOwner.client.putProgramOrder(w.streamId, revision, listOf(b, a)) },
                { it.exec("UPDATE work_streams SET owner_person_id = ? WHERE id = ?", w.stranger.personId!!.toInt(), w.streamId.toInt()) },
            )
            assertEquals(HttpStatusCode.Forbidden, response.status, "the outer guard passed; the re-check under the lock did not")
            val denied = capture.awaitEvent {
                it.message == "authz.denied" && it.hasKeyValue("path", "/api/v1/work-streams/${w.streamId}/program-order")
            }
            assertNotNull(denied, "the re-guard refusal is audited centrally")
            assertTrue(denied.hasKeyValue("byUserId", w.streamOwner.userId.toLong()))
            val caller = w.streamOwner.userId.toLong()
            assertTrue(capture.events.none { it.message == "work_stream.program_order_changed" && it.hasKeyValue("byUserId", caller) })
        }
        assertEquals(revision, TestPlan.revision())
        assertEquals(dense(listOf(a, b)), TestPlan.programOrderRows(w.streamId))
    }

    @Test
    fun `a stale row left by a rolled-back build is repaired by the next PUT - it cannot break the insert`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("plstale")
        val owner = w.streamOwner.personId!!
        val other = TestPlan.workStream(owner)
        val (ghost, moved, plain) = List(3) { TestPlan.program(w.streamId, w.programOwner.personId!!) }
        val deadStream = TestPlan.workStream(owner)
        TestPlan.resetWorkStreamOrder()
        try {
            // A 1.27 build deleted `ghost` and moved `moved` out of the stream without the hooks: both rows are stale. `moved` is back
            // under this stream now, with a row still naming the OTHER stream; `deadStream` is soft-deleted but still listed.
            TestPlan.programOrder(w.streamId, listOf(ghost))
            rawSql("UPDATE programs SET marked_as_deleted = TRUE WHERE id = $ghost")
            rawSql("INSERT INTO program_orders (program_id, work_stream_id, position) VALUES ($moved, $other, 1)")
            TestPlan.workStreamOrder(listOf(deadStream, w.streamId))
            rawSql("UPDATE work_streams SET marked_as_deleted = TRUE WHERE id = $deadStream")
            assertEquals(dense(listOf(ghost)), TestPlan.programOrderRows(w.streamId))

            val revision = requireNotNull(TestPlan.programOrderRevision(w.streamId))
            assertEquals(ok, w.streamOwner.client.putProgramOrder(w.streamId, revision, listOf(moved, plain)).status)
            assertEquals(dense(listOf(moved, plain)), TestPlan.programOrderRows(w.streamId), "the ghost's row is gone")
            assertEquals(emptyList(), TestPlan.programOrderRows(other), "the stale row of the other stream was swept by program id")

            assertEquals(ok, w.admin.client.putWorkStreamOrder(TestPlan.revision(), listOf(w.streamId, other)).status)
            assertEquals(dense(listOf(w.streamId, other)), TestPlan.workStreamOrderRows(), "the dead stream's row is gone")
        } finally {
            TestPlan.resetWorkStreamOrder()
        }
    }
}
