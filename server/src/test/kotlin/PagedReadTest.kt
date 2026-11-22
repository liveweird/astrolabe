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
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals

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
}
