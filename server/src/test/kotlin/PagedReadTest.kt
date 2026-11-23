package ch.nokillswit

import ch.nokillswit.infra.paging.pagedRead
import ch.nokillswit.teams.TeamService
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import org.jetbrains.exposed.v1.core.like
import org.jetbrains.exposed.v1.r2dbc.selectAll
import java.io.File
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The API-LIST-001 snapshot shared by every count-plus-page service. */
class PagedReadTest {
    @Test
    fun `a committed insert between count and rows is not visible to the page snapshot`() = runBlocking {
        val database = sharedDatabaseForTests()
        val marker = "paged-${UUID.randomUUID()}"
        TestTeams.seed("$marker-before")
        val countFinished = CompletableDeferred<Unit>()
        val writerFinished = CompletableDeferred<Unit>()

        coroutineScope {
            val reader = async(Dispatchers.IO) {
                pagedRead(database) {
                    val before = TeamService.Teams.selectAll().where { TeamService.Teams.name like "$marker%" }.count()
                    countFinished.complete(Unit)
                    writerFinished.await()
                    val after = TeamService.Teams.selectAll().where { TeamService.Teams.name like "$marker%" }.count()
                    before to after
                }
            }

            countFinished.await()
            try {
                TestTeams.seed("$marker-after")
            } finally {
                writerFinished.complete(Unit)
            }

            assertEquals(1L to 1L, reader.await())
        }
    }

    /**
     * The snapshot above is only a guarantee for a service that reads through [pagedRead]: this source guard (the `PackageBoundaryTest`
     * style, no classpath tricks) pins that every `applyPaging` call - one per paged `list` (users, people, teams, projects, milestones,
     * the Jira connections and bindings, the Flow connections) - sits in a function whose header-to-call text opens with `pagedRead(` and
     * holds no bare `suspendTransaction(`, so a new paged list cannot silently read its count and its page in two snapshots.
     */
    @Test
    fun `every paged list in the services reads through pagedRead and not a bare suspendTransaction`() {
        val root = File(System.getProperty("repo.root") ?: "..", "server/src/main/kotlin")
        assertTrue(root.isDirectory, "${root.absolutePath} not found")
        val sources = root.walkTopDown().filter { it.isFile && it.extension == "kt" && "infra/paging" !in it.path }.toList()
        val violations = mutableListOf<String>()
        var paged = 0
        for (file in sources) {
            val text = file.readText()
            var from = text.indexOf(".applyPaging(")
            while (from >= 0) {
                paged++
                val header = text.lastIndexOf("suspend fun ", from)
                val body = if (header < 0) "" else text.substring(header, from)
                if (header < 0 || "pagedRead(" !in body || "suspendTransaction(" in body) {
                    violations += "${file.name}: the paged read at offset $from is not inside a pagedRead { } function"
                }
                from = text.indexOf(".applyPaging(", from + 1)
            }
        }
        assertEquals(emptyList(), violations)
        assertTrue(paged >= 8, "the scan found only $paged paged lists (users, people, teams, projects, milestones, Jira x2, Flow)")
    }
}
