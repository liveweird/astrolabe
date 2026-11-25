package ch.nokillswit

import ch.nokillswit.planning.PlanOrderResponse
import ch.nokillswit.planning.PlanView
import ch.nokillswit.planning.PlanWorkStream
import ch.nokillswit.planning.ProgramMoveRequest
import ch.nokillswit.planning.ProgramsView
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The plan view (`GET /views/plan`) and the programs view (`GET /views/programs`) FOLLOW the shared order (V34, `plan-tree.md`): the
 * work stream list and each stream's program list, closed streams last whatever their position, unlisted nodes after the listed ones by
 * name, a stale row inert; the revisions the plan view answers are the ones the two PUTs compare, and its `order*` flags equal the
 * real PUTs' verdicts. With no row stored the order is by name, which `PlanViewTest` and `ProgramsViewTest` keep pinning. The work
 * stream order is ONE global list: every test that writes it ends by emptying it.
 */
class PlanOrderViewTest {
    private suspend fun HttpClient.plan(): PlanView = get("/api/v1/views/plan").body()

    private suspend fun HttpClient.programsView(): ProgramsView = get("/api/v1/views/programs").body()

    /** This test's work streams of the plan view, in the view's order. */
    private fun PlanView.streamsOf(ids: Collection<UInt>): List<UInt> = workStreams.map { it.id }.filter { it in ids }

    private fun ProgramsView.streamsOf(ids: Collection<UInt>): List<UInt> = workStreams.map { it.id }.filter { it in ids }

    private fun PlanView.stream(id: UInt): PlanWorkStream = workStreams.single { it.id == id }

    @Test
    fun `both views list the work streams in the stored order, the unlisted ones after them by name and closed ones last`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pov-streams")
            val owner = w.streamOwner.personId!!
            val p = planName("pvs")
            val a = TestPlan.workStream(owner, "$p-a")
            val b = TestPlan.workStream(owner, "$p-b")
            val c = TestPlan.workStream(owner, "$p-c")
            val d = TestPlan.workStream(owner, "$p-d")
            val closed = TestPlan.workStream(owner, "$p-0-closed", endDate = "2026-06-30")
            val mine = setOf(a, b, c, d, closed)
            try {
                val client = w.stranger.client
                assertEquals(listOf(a, b, c, d, closed), client.plan().streamsOf(mine), "nothing stored: by name, the closed one last")
                assertEquals(listOf(a, b, c, d, closed), client.programsView().streamsOf(mine))

                // The closed stream is listed FIRST: it still comes last. c is listed ahead of b, a and d stay unlisted.
                TestPlan.workStreamOrder(listOf(closed, c, b))
                val expected = listOf(c, b, a, d, closed)
                assertEquals(expected, client.plan().streamsOf(mine), "listed c, b first; unlisted a, d by name; closed last")
                assertEquals(expected, client.programsView().streamsOf(mine))

                TestPlan.resetWorkStreamOrder()
                assertEquals(listOf(a, b, c, d, closed), client.plan().streamsOf(mine), "the reset is name order again")
                assertEquals(listOf(a, b, c, d, closed), client.programsView().streamsOf(mine))
            } finally {
                TestPlan.resetWorkStreamOrder()
            }
        }

    @Test
    fun `both views list a work stream's programs in its program order, the others by name, and the projects stay by name`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("pov-programs")
            val owner = w.streamOwner.personId!!
            val p = planName("pvp")
            val stream = TestPlan.workStream(owner, "$p-ws")
            val otherStream = TestPlan.workStream(owner, "$p-ws-other")
            val a = TestPlan.program(stream, owner, "$p-a")
            val b = TestPlan.program(stream, owner, "$p-b")
            val c = TestPlan.program(stream, owner, "$p-c")
            val z = TestPlan.program(otherStream, owner, "$p-z")
            val y = TestPlan.program(otherStream, owner, "$p-y")
            TestPlan.project(c, owner, "$p-j2")
            TestPlan.project(c, owner, "$p-j1")
            val client = w.stranger.client
            fun PlanView.programs(id: UInt) = stream(id).programs.map { it.id }
            fun ProgramsView.programs(id: UInt) = workStreams.single { it.id == id }.programs.map { it.id }

            assertEquals(listOf(a, b, c), client.plan().programs(stream), "nothing stored: by name")
            TestPlan.programOrder(stream, listOf(c, a))
            val plan = client.plan()
            assertEquals(listOf(c, a, b), plan.programs(stream), "listed c, a, then the unlisted b")
            assertEquals(listOf(c, a, b), client.programsView().programs(stream))
            assertEquals(listOf(y, z), plan.programs(otherStream), "another stream's list is its own")
            assertEquals(listOf("$p-j1", "$p-j2"), plan.stream(stream).programs.first().projects.map { it.name }, "projects stay by name")

            TestPlan.programOrder(stream, emptyList())
            assertEquals(listOf(a, b, c), client.plan().programs(stream), "the reset")
            assertEquals(listOf(a, b, c), client.programsView().programs(stream))
        }

    @Test
    fun `a stale row of a program that moved to another work stream is inert in both views`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pov-stale")
        val owner = w.streamOwner.personId!!
        val p = planName("pvx")
        val source = TestPlan.workStream(owner, "$p-source")
        val target = TestPlan.workStream(owner, "$p-target")
        val first = TestPlan.program(source, owner, "$p-first")
        val moved = TestPlan.program(source, owner, "$p-aaa-moved")
        val late = TestPlan.program(target, owner, "$p-zzz-late")
        TestPlan.programOrder(source, listOf(moved))
        TestPlan.programOrder(target, listOf(late))
        val client = w.stranger.client
        assertEquals(HttpStatusCode.NoContent, w.admin.client.postJson("/api/v1/programs/$moved/move", ProgramMoveRequest(target)).status)
        assertEquals(emptyList(), TestPlan.programOrderRows(source), "the move hook took it out of the source list")
        // What a rolled-back 1.27 build leaves behind: a row naming the stream the program moved out of, tying the listed program's
        // first place (the name would then decide, and "aaa-moved" sorts ahead of "zzz-late").
        PostgresTestSupport.connect().use {
            it.exec("INSERT INTO program_orders (program_id, work_stream_id, position) VALUES (?, ?, 1)", moved.toInt(), source.toInt())
        }
        try {
            val expected = listOf(late, moved)
            assertEquals(expected, client.plan().stream(target).programs.map { it.id }, "unlisted in the target: by name, after late")
            assertEquals(expected, client.programsView().workStreams.single { it.id == target }.programs.map { it.id })
            assertEquals(listOf(first), client.plan().stream(source).programs.map { it.id })
        } finally {
            PostgresTestSupport.connect().use { it.exec("DELETE FROM program_orders WHERE program_id = ?", moved.toInt()) }
        }
    }

    @Test
    fun `the revisions the plan view answers are the ones the PUTs compare - 0 while never written, each list its own`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pov-rev")
        val owner = w.streamOwner.personId!!
        val other = TestPlan.workStream(owner)
        TestPlan.program(w.streamId, owner)
        val client = w.stranger.client
        try {
            val before = client.plan()
            assertEquals(TestPlan.workStreamOrderRevision(), before.workStreamOrderRevision)
            assertEquals(0L, before.stream(w.streamId).programOrderRevision, "never written")
            assertEquals(0L, before.stream(other).programOrderRevision)

            val written = w.admin.client.putWorkStreamOrder(before.workStreamOrderRevision, listOf(other, w.streamId))
            val streamRevision = written.body<PlanOrderResponse>().revision
            val plan = client.plan()
            assertEquals(streamRevision, plan.workStreamOrderRevision, "the PUT's answer is the view's next expectedRevision")
            assertEquals(TestPlan.revision(), plan.revision)
            assertEquals(0L, plan.stream(w.streamId).programOrderRevision, "the other list is untouched")

            val programRevision = w.streamOwner.client.putProgramOrder(w.streamId, 0, emptyList()).body<PlanOrderResponse>().revision
            val after = client.plan()
            assertEquals(programRevision, after.stream(w.streamId).programOrderRevision)
            assertEquals(0L, after.stream(other).programOrderRevision, "another stream's list is its own")
            assertEquals(streamRevision, after.workStreamOrderRevision, "a program order write never moves the stream list's revision")
            // The answered revisions are accepted by the PUTs (not stale).
            assertEquals(HttpStatusCode.OK, w.admin.client.putWorkStreamOrder(after.workStreamOrderRevision, emptyList()).status)
            assertEquals(HttpStatusCode.OK, w.streamOwner.client.putProgramOrder(w.streamId, programRevision, emptyList()).status)
        } finally {
            TestPlan.resetWorkStreamOrder()
        }
    }

    @Test
    fun `the order flags are set exactly where the real PUTs let the caller through`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("pov-can")
        val everyone = listOf(
            "admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner,
            "project owner" to w.projectOwner, "stranger" to w.stranger, "personless" to w.personless, "editor" to w.editor,
        )
        fun status(allowed: Boolean) = if (allowed) HttpStatusCode.OK else HttpStatusCode.Forbidden
        var admitted = 0
        try {
            for ((label, caller) in everyone) {
                val view = caller.client.plan()
                val stream = view.stream(w.streamId)
                // A reset of an empty list at the list's own revision: it changes no order, only the plan revision.
                assertEquals(
                    status(view.can.orderWorkStreams),
                    caller.client.putWorkStreamOrder(view.workStreamOrderRevision, emptyList()).status,
                    "$label: work stream order",
                )
                assertEquals(
                    status(stream.can.orderPrograms),
                    caller.client.putProgramOrder(w.streamId, stream.programOrderRevision, emptyList()).status,
                    "$label: program order",
                )
                if (view.can.orderWorkStreams) admitted++
                if (stream.can.orderPrograms) admitted++
            }
            val expected = mapOf(
                "admin" to (true to true), "stream owner" to (false to true), "program owner" to (false to false),
                "project owner" to (false to false), "stranger" to (false to false), "personless" to (false to false),
                "editor" to (false to false),
            )
            for ((label, caller) in everyone) {
                val view = caller.client.plan()
                assertEquals(expected.getValue(label), view.can.orderWorkStreams to view.stream(w.streamId).can.orderPrograms, label)
            }
            assertEquals(3, admitted, "ADMIN twice and the stream's owner once")
            // A stream the caller does not own: the flag follows THAT stream's chain.
            val ownersView = w.streamOwner.client.plan()
            val foreign = TestPlan.workStream(w.programOwner.personId!!)
            assertTrue(ownersView.stream(w.streamId).can.orderPrograms)
            assertEquals(false, w.streamOwner.client.plan().stream(foreign).can.orderPrograms, "owning another stream orders nothing here")
            assertEquals(HttpStatusCode.Forbidden, w.streamOwner.client.putProgramOrder(foreign, 0, emptyList()).status)
        } finally {
            TestPlan.resetWorkStreamOrder()
        }
    }
}
