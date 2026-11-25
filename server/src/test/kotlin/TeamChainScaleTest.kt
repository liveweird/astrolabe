package ch.nokillswit

import ch.nokillswit.auth.LoginResponse
import ch.nokillswit.planning.MAX_TEAM_CHAIN_MEMBERS
import ch.nokillswit.planning.TeamView
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.DefaultRequest
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsBytes
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.sql.Connection
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.TemporalAdjusters
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The team view's chain block at its caps (1.27, `?criticalChain=true`). The kernel's vectors and the assembly are pure tests'; the
 * sample plan's own dates are random, so almost no link has zero slack and its chain would be empty: this world builds its own.
 * ONE team has 12 milestones, each the last of its own project (week 11 of a year far past anything else the suite schedules, so no
 * holiday of the shared dictionary is near), and each is fed by a back-to-back finish-to-start chain of 10 one-week milestones of
 * ANOTHER team in a project of their own (weeks 10 down to 1): 120 members at 1 to 10 hops, 12 at each level, so the 100-member cap
 * cuts inside level 9 and keeps 4 of its 12 (the first four by name). Hand-counted: 100 members, none beyond 9 hops, and of the 108
 * links between two members the ones between two KEPT members: 4 chains of 9 members keep 8 links each and 8 chains of 8 members
 * keep 7 each, 88 (the 12 links into the team's own milestones are `dependencies[]` rows). Seeded over raw JDBC in ONE transaction (no
 * plan lock, no revision bump; every name starts with the test's unique prefix) and hard-deleted in a `NonCancellable` `finally`.
 *
 * Reads the view plain and with the parameter through the conformance-checked client (the shape), then times each through a bare
 * bearer client (a warm-up and [RUNS] timed reads); the block's bytes and both medians are `scale-figure` lines.
 * The asserted bounds are the byte gate ([MAX_BLOCK_BYTES]) and a loose tripwire.
 */
class TeamChainScaleTest {
    private class World(val teamId: UInt)

    private val firstMonday: LocalDate = LocalDate.of(YEAR, 1, 1).with(TemporalAdjusters.nextOrSame(DayOfWeek.MONDAY))

    /** `'start', 'end'` of the one-week milestone of week [week] (1-based): Monday to Friday. */
    private fun dates(week: Int): String = firstMonday.plusWeeks(week - 1L).let { "'$it', '${it.plusDays(4)}'" }

    private fun seed(prefix: String, owner: UInt): World {
        val now = System.currentTimeMillis()
        val stamps = "$now, $now"
        return PostgresTestSupport.connect().use { c ->
            c.autoCommit = false
            try {
                val streamColumns = "name, owner_person_id, start_date, created_at, updated_at"
                c.insert("work_streams", streamColumns, listOf("('$prefix-ws', $owner, '2026-01-01', $stamps)"))
                val stream = c.idsByName("work_streams", "$prefix-ws").values.single()
                val ownedColumns = "name, work_stream_id, owner_person_id, created_at, updated_at"
                c.insert("programs", ownedColumns, listOf("('$prefix-pg', $stream, $owner, $stamps)"))
                val program = c.idsByName("programs", "$prefix-pg").values.single()
                val chains = (1..CHAINS).map { it.pad() }
                val projects = chains.flatMap {
                    listOf("('$prefix-pj-t$it', $program, $owner, $stamps)", "('$prefix-pj-f$it', $program, $owner, $stamps)")
                }
                c.insert("projects", "name, program_id, owner_person_id, created_at, updated_at", projects)
                val projectIds = c.idsByName("projects", "$prefix-pj-")
                c.insert("teams", "name, created_at, updated_at", listOf("('$prefix-t1', $stamps)", "('$prefix-t2', $stamps)"))
                val teamIds = c.idsByName("teams", "$prefix-t")
                val team = teamIds.getValue("$prefix-t1")
                val feeders = teamIds.getValue("$prefix-t2")

                fun milestone(project: String, teamId: Int, name: String, week: Int) =
                    "(${projectIds.getValue("$prefix-pj-$project")}, $teamId, '$prefix-m-$name', 2, ${dates(week)}, FALSE, 0, $stamps)"

                val milestones = chains.flatMap { chain ->
                    listOf(milestone("t$chain", team, "t$chain", LAST_WEEK)) +
                        (1..CHAIN_LENGTH).map { k -> milestone("f$chain", feeders, "c$chain-${k.pad()}", LAST_WEEK - k) }
                }
                val milestoneColumns =
                    "project_id, team_id, name, estimate_md, start_date, end_date, pinned, schedule_revision, created_at, updated_at"
                c.insert("milestones", milestoneColumns, milestones)
                val ids = c.idsByName("milestones", "$prefix-m-")
                val links = chains.flatMap { chain ->
                    // c10 -> c09 -> ... -> c01 -> the team's milestone.
                    (CHAIN_LENGTH downTo 1).map { k ->
                        val successor = if (k == 1) "t$chain" else "c$chain-${(k - 1).pad()}"
                        "(${ids.getValue("$prefix-m-c$chain-${k.pad()}")}, ${ids.getValue("$prefix-m-$successor")}, 'FS', 0, $stamps)"
                    }
                }
                c.insert("dependencies", "pred_milestone_id, succ_milestone_id, type, lag_days, created_at, updated_at", links)
                c.commit()
                World(team.toUInt())
            } catch (e: Throwable) {
                c.rollback()
                throw e
            }
        }
    }

    /** Hard-deletes everything [seed] made under [prefix], children first; safe after a failed or partial seed. */
    private fun remove(prefix: String) {
        val teams = "SELECT id FROM teams WHERE name LIKE '$prefix-t%'"
        val milestones = "SELECT id FROM milestones WHERE team_id IN ($teams)"
        PostgresTestSupport.connect().use { c ->
            c.createStatement().use { st ->
                val touching = "pred_milestone_id IN ($milestones) OR succ_milestone_id IN ($milestones)"
                st.executeUpdate("DELETE FROM dependencies WHERE $touching")
                st.executeUpdate("DELETE FROM milestones WHERE team_id IN ($teams)")
                st.executeUpdate("DELETE FROM teams WHERE name LIKE '$prefix-t%'")
                st.executeUpdate("DELETE FROM projects WHERE name LIKE '$prefix-pj-%'")
                st.executeUpdate("DELETE FROM programs WHERE name = '$prefix-pg'")
                st.executeUpdate("DELETE FROM work_streams WHERE name = '$prefix-ws'")
                st.executeUpdate("DELETE FROM people WHERE name = '$prefix-owner'")
            }
        }
    }

    private fun remaining(prefix: String): Int = PostgresTestSupport.connect().use { c ->
        c.createStatement().use { st ->
            val tables = listOf("milestones" to "m-", "teams" to "t", "projects" to "pj-", "programs" to "pg", "work_streams" to "ws")
            val counts = tables.map { (table, tag) -> "(SELECT count(*) FROM $table WHERE name LIKE '$prefix-$tag%')" }
            val sql = "SELECT ${counts.joinToString(" + ")}"
            st.executeQuery(sql).use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }
    }

    private fun Int.pad() = toString().padStart(2, '0')

    private fun Connection.insert(table: String, columns: String, rows: List<String>) {
        createStatement().use { st ->
            rows.chunked(CHUNK).forEach { st.executeUpdate("INSERT INTO $table ($columns) VALUES ${it.joinToString(", ")}") }
        }
    }

    private fun Connection.idsByName(table: String, like: String): Map<String, Int> =
        createStatement().use { st ->
            st.executeQuery("SELECT id, name FROM $table WHERE name LIKE '$like%'").use { rs ->
                buildMap { while (rs.next()) put(rs.getString(2), rs.getInt(1)) }
            }
        }

    /** A seeded login with a bare bearer client beside the conformance-checked one. */
    private class Reader(val conformant: HttpClient, val bare: HttpClient)

    private suspend fun ApplicationTestBuilder.reader(prefix: String): Reader {
        val email = uniqueEmail(prefix)
        TestUsers.seed(email = email, password = "pw")
        val token = jsonClient().login(email, "pw").body<LoginResponse>().token
        val bare = createClient { install(DefaultRequest) { header(HttpHeaders.Authorization, "Bearer $token") } }
        return Reader(authedClient(email, "pw"), bare)
    }

    /** One warm-up, then [RUNS] timed reads of [path] (200 each): the timings in milliseconds. */
    private suspend fun HttpClient.timings(path: String): List<Double> {
        assertEquals(HttpStatusCode.OK, get(path).status, path)
        return List(RUNS) {
            val started = System.nanoTime()
            assertEquals(HttpStatusCode.OK, get(path).status, path)
            (System.nanoTime() - started) / NANOS_PER_MILLI
        }
    }

    @Test
    fun `twelve chains of ten at the caps - 100 members, none past nine hops, every link between two, the plain document unchanged`() =
        testApplication {
            usePostgresTestcontainer()
            val prefix = planName("tcs")
            try {
                val owner = TestPeople.seed("$prefix-owner")
                val world = seed(prefix, owner)
                val reader = reader("tcs-rd")
                val plainPath = "/api/v1/views/team/${world.teamId}"
                val chainPath = "$plainPath?criticalChain=true"

                val plainText = reader.conformant.get(plainPath).bodyAsText()
                val chainText = reader.conformant.get(chainPath).bodyAsText()
                assertFalse(plainText.contains("criticalChain"), "without the parameter the document has no block")
                val plain = reader.conformant.rawJson(plainPath)
                val withChain = reader.conformant.rawJson(chainPath).jsonObject
                assertEquals(plain, JsonObject(withChain.filterKeys { it != "criticalChain" }), "the block is the only difference")

                val view = Json { ignoreUnknownKeys = true }.decodeFromString<TeamView>(chainText)
                val block = assertNotNull(view.criticalChain)
                assertEquals(CHAINS, view.scheduled.size)
                assertEquals(CHAINS, view.dependencies.count { it.critical }, "the 12 links into the team's milestones are critical rows")
                assertTrue(block.truncated, "120 members were on the chain")
                assertEquals(MAX_TEAM_CHAIN_MEMBERS, block.members.size)
                assertTrue(block.members.all { it.hops in 1..CUT_LEVEL }, "levels 1 to 9: ${block.members.map { it.hops }.distinct()}")
                assertEquals(CHAINS * (CUT_LEVEL - 1), block.members.count { it.hops < CUT_LEVEL }, "all of levels 1 to 8")
                assertEquals(MAX_TEAM_CHAIN_MEMBERS - CHAINS * (CUT_LEVEL - 1), block.members.count { it.hops == CUT_LEVEL })
                val listed = block.members.map { it.kind to it.id }.toSet()
                assertTrue(block.links.all { link -> listOf(link.predecessor, link.successor).all { (it.kind to it.id) in listed } })
                assertEquals(EXPECTED_LINKS, block.links.size)

                val blockBytes = withChain.getValue("criticalChain").toString().toByteArray().size
                val plainTimings = reader.bare.timings(plainPath)
                val chainTimings = reader.bare.timings(chainPath)
                ScaleFigures.printBytes("team chain block (${block.members.size} members, ${block.links.size} links)", blockBytes)
                val gzip = reader.bare.get(chainPath) { header(HttpHeaders.AcceptEncoding, "gzip") }.bodyAsBytes().size
                ScaleFigures.printBytes("team view with the chain, gzip", gzip)
                ScaleFigures.printSeries("team view plain, 12 projects", plainTimings)
                ScaleFigures.printSeries("team view with the chain, 12 projects", chainTimings)
                assertTrue(blockBytes <= MAX_BLOCK_BYTES, "the chain block is $blockBytes B, over the $MAX_BLOCK_BYTES gate")
                assertTrue(ScaleFigures.median(chainTimings) <= TRIPWIRE_MS, "median ${ScaleFigures.median(chainTimings)} ms")
            } finally {
                // NonCancellable: a test cancelled by the 60 s limit must still take its rows out of the shared plan.
                withContext(NonCancellable) { remove(prefix) }
            }
            assertEquals(0, remaining(prefix), "the synthetic plan is hard-deleted")
        }

    private companion object {
        /** A year far past anything the suite schedules or holidays (the holiday cases sit in 2027 and 2900-2999). */
        const val YEAR = 2600
        const val CHAINS = 12
        const val CHAIN_LENGTH = 10
        const val LAST_WEEK = CHAIN_LENGTH + 1

        /** The level the 100-member cap cuts inside: 12 members at 9 hops, 4 of them kept. */
        const val CUT_LEVEL = CHAIN_LENGTH - 1
        const val CHUNK = 250
        const val RUNS = 5
        const val NANOS_PER_MILLI = 1_000_000.0

        /** 4 chains keep 9 members and 8 links, 8 chains keep 8 members and 7 links (hand-counted in the class comment). */
        const val EXPECTED_LINKS = 4 * 8 + 8 * 7

        /** The measured 32,693 B (100 members, 88 links) plus 10 percent. */
        const val MAX_BLOCK_BYTES = 36_000

        /** A loose tripwire, at least 5x the figure expected on the dev machine, never the machine's speed. */
        const val TRIPWIRE_MS = 1_000.0
    }
}
