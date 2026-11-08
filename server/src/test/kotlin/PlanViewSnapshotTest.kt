package ch.nokillswit

import ch.nokillswit.planning.PlanView
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * `GET /views/plan` reads the revision and the tree from ONE snapshot (`SNAPSHOT`, the timeline views' protocol), pinned without
 * timing: a raw session holds `ACCESS EXCLUSIVE` on `programs`, so the view's second select blocks (`pg_stat_activity` shows the wait);
 * while it waits, a plan write (a project rename plus the revision bump) commits on another session. At READ COMMITTED the
 * third select would then see the new name next to the OLD revision; at REPEATABLE READ both stay what the first statement saw.
 */
class PlanViewSnapshotTest {
    @Test
    fun `a plan write that commits between the view's selects cannot tear the response`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("snap")
        val before = TestPlan.revision()
        val oldName = planName("snap-old")
        val newName = planName("snap-new")
        PostgresTestSupport.connect().use { c -> c.update("UPDATE projects SET \"name\" = ? WHERE id = ?", oldName, w.projectId.toInt()) }

        val torn = PostgresTestSupport.connect().use { holder ->
            holder.autoCommit = false
            holder.createStatement().use { it.execute("LOCK TABLE programs IN ACCESS EXCLUSIVE MODE") }
            try {
                coroutineScope {
                    val reading = async { w.stranger.client.get("/api/v1/views/plan").body<PlanView>() }
                    // The view has taken its snapshot (the revision select ran first) and is now stuck on `programs`.
                    awaitLockWait("FROM programs")
                    PostgresTestSupport.connect().use { writer ->
                        writer.update("UPDATE projects SET \"name\" = ? WHERE id = ?", newName, w.projectId.toInt())
                        writer.update("UPDATE plan_state SET revision = revision + 1 WHERE id = 1")
                    }
                    holder.rollback()
                    reading.await()
                }
            } finally {
                holder.rollback()
            }
        }

        assertEquals(before, torn.revision, "the revision is the one the snapshot saw")
        val project = torn.workStreams.flatMap { it.programs }.flatMap { it.projects }.single { it.id == w.projectId }
        assertEquals(oldName, project.name, "the project is as of the same snapshot, not the write that committed meanwhile")

        val after = w.stranger.client.get("/api/v1/views/plan").body<PlanView>()
        assertEquals(before + 1, after.revision, "the write really landed: the next view shows it")
        assertEquals(newName, after.workStreams.flatMap { it.programs }.flatMap { it.projects }.single { it.id == w.projectId }.name)
    }

    private fun java.sql.Connection.update(sql: String, vararg params: Any) {
        prepareStatement(sql).use { st ->
            params.forEachIndexed { i, p -> st.setObject(i + 1, p) }
            st.executeUpdate()
        }
    }
}
