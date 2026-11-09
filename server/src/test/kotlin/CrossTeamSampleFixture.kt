package ch.nokillswit

import java.sql.Connection
import java.time.DayOfWeek
import java.time.LocalDate
import kotlin.random.Random

/** What [CrossTeamSampleFixture.seed] created: the 15 [teamIds] (the run's request) and the figures the size test logs. */
internal class CrossTeamSample(val teamIds: List<UInt>, val milestones: Int, val scheduled: Int, val links: Int, val crossTeamLinks: Int)

/**
 * A SYNTHETIC plan of the sample plan's density, seeded over raw JDBC in ONE transaction (multi-row INSERTs; nothing is created through
 * the services, so no plan lock is taken and no revision moves) for `CrossTeamProposalSizeTest`, the 600,000-byte gate of the 1.8 run:
 * 5 work streams, 20 programs, 100 projects of ten milestones, 15 teams of the sample's sizes (301/101/60/.../20 = 1,000 milestones),
 * 90 % of the milestones scheduled over 2027-2029 (Monday starts, 1-10 working days, 1-20 MD, one in fifty of them pinned), about 300
 * Finish-to-Start links between milestones of which about 30 % cross two teams, and per team a capacity period from 2026-01-05 (10-60
 * MD a week by size, a lower second period from 2028 on every third team) with a WIP limit on half the teams.
 *
 * Every link points from a lower milestone number to a higher one and a project holds ten consecutive numbers, so the plan is acyclic by
 * construction (the run checks it). The numbers come from a fixed seed: the same plan every run. Every row's name starts with the
 * caller's unique `prefix`, so [remove] hard-deletes exactly the rows [seed] made (the shared container's other views stay fast) and
 * can run after a half-finished seed. The real sample plan is loaded only by `scripts/sample-plan/load.mjs`, which no test touches.
 */
internal object CrossTeamSampleFixture {
    /** The sample plan's milestones per team (Platform first), summing to 1,000. */
    private val TEAM_SIZES = listOf(301, 101, 60, 75, 151, 50, 43, 38, 34, 27, 30, 25, 23, 22, 20)
    private const val STREAMS = 5
    private const val PROGRAMS = 20
    private const val PROJECTS = 100
    private const val LINKS = 300
    private const val CROSS_TEAM_SHARE = 0.3
    private const val LINK_WINDOW = 80
    private const val CHUNK = 250
    private const val SEED = 20_261_109

    suspend fun seed(prefix: String): CrossTeamSample {
        val owner = TestPeople.seed("$prefix-owner")
        val random = Random(SEED)
        val now = System.currentTimeMillis()
        PostgresTestSupport.connect().use { c ->
            c.autoCommit = false
            try {
                val sample = insertAll(c, prefix, owner, random, now)
                c.commit()
                return sample
            } catch (e: Throwable) {
                c.rollback()
                throw e
            }
        }
    }

    private fun insertAll(c: Connection, prefix: String, owner: UInt, random: Random, now: Long): CrossTeamSample {
        val stamps = "$now, $now"
        val streams = (1..STREAMS).map { "('$prefix-ws$it', $owner, '2026-01-01', $stamps)" }
        c.insert("work_streams", "name, owner_person_id, start_date, created_at, updated_at", streams)
        val streamIds = c.idsByName("work_streams", "$prefix-ws")
        val programs = (1..PROGRAMS).map {
            "('$prefix-pg$it', ${streamIds.getValue("$prefix-ws${(it - 1) % STREAMS + 1}")}, $owner, $stamps)"
        }
        c.insert("programs", "name, work_stream_id, owner_person_id, created_at, updated_at", programs)
        val programIds = c.idsByName("programs", "$prefix-pg")
        val projects = (1..PROJECTS).map {
            "('$prefix-pj$it', ${programIds.getValue("$prefix-pg${(it - 1) % PROGRAMS + 1}")}, $owner, $stamps)"
        }
        c.insert("projects", "name, program_id, owner_person_id, created_at, updated_at", projects)
        val projectIds = c.idsByName("projects", "$prefix-pj")

        c.insert("teams", "name, created_at, updated_at", TEAM_SIZES.indices.map { "('$prefix-t${it + 1}', $stamps)" })
        val teamIds = c.idsByName("teams", "$prefix-t")
        insertCapacity(c, prefix, teamIds, now)

        val teamOfNumber = TEAM_SIZES.flatMapIndexed { team, size -> List(size) { team } }.shuffled(random)
        var scheduled = 0
        val milestones = teamOfNumber.mapIndexed { number, team ->
            val projectId = projectIds.getValue("$prefix-pj${number / (teamOfNumber.size / PROJECTS) + 1}")
            val dates = if (random.nextInt(10) == 0) "NULL, NULL, FALSE" else scheduledDates(random, ++scheduled)
            "($projectId, ${teamIds.getValue("$prefix-t${team + 1}")}, '$prefix-m$number', ${1 + random.nextInt(20)}, $dates, 0, $stamps)"
        }
        val milestoneColumns =
            "project_id, team_id, name, estimate_md, start_date, end_date, pinned, schedule_revision, created_at, updated_at"
        c.insert("milestones", milestoneColumns, milestones)
        val milestoneIds = c.idsByName("milestones", "$prefix-m")
        val links = linkPairs(random, teamOfNumber)
        val linkRows = links.map { (pred, succ) ->
            "(${milestoneIds.getValue("$prefix-m$pred")}, ${milestoneIds.getValue("$prefix-m$succ")}, 'FS', 0, $stamps)"
        }
        c.insert("dependencies", "pred_milestone_id, succ_milestone_id, type, lag_days, created_at, updated_at", linkRows)
        return CrossTeamSample(
            teamIds = TEAM_SIZES.indices.map { teamIds.getValue("$prefix-t${it + 1}").toUInt() },
            milestones = milestones.size,
            scheduled = scheduled,
            links = links.size,
            crossTeamLinks = links.count { (pred, succ) -> teamOfNumber[pred] != teamOfNumber[succ] },
        )
    }

    /** The SQL `'start', 'end', pinned` of the [ordinal]-th scheduled milestone: a Monday start in 2027-2029, 1-10 working days. */
    private fun scheduledDates(random: Random, ordinal: Int): String {
        val start = LocalDate.of(2027, 1, 4).plusWeeks(random.nextLong(156))
        var end = start
        repeat(random.nextInt(10)) {
            end = end.plusDays(1)
            if (end.dayOfWeek == DayOfWeek.SATURDAY) end = end.plusDays(2)
        }
        return "'$start', '$end', ${ordinal % 50 == 0}"
    }

    /** About 300 distinct pairs `(lower number, higher number)`, about 30 % across two teams: every edge goes forward, so no cycle. */
    private fun linkPairs(random: Random, teamOfNumber: List<Int>): List<Pair<Int, Int>> {
        val pairs = LinkedHashSet<Pair<Int, Int>>()
        var attempts = 0
        while (pairs.size < LINKS && attempts++ < LINKS * 20) {
            val succ = random.nextInt(10, teamOfNumber.size)
            val cross = random.nextDouble() < CROSS_TEAM_SHARE
            val candidates = (maxOf(0, succ - LINK_WINDOW) until succ).filter { (teamOfNumber[it] != teamOfNumber[succ]) == cross }
            if (candidates.isNotEmpty()) pairs.add(candidates[random.nextInt(candidates.size)] to succ)
        }
        return pairs.toList()
    }

    private fun insertCapacity(c: Connection, prefix: String, teamIds: Map<String, Int>, now: Long) {
        val rows = TEAM_SIZES.flatMapIndexed { index, size ->
            val team = teamIds.getValue("$prefix-t${index + 1}")
            val md = (size / 5).coerceIn(10, 60)
            val wip = if (index % 2 == 0) (4 + index % 4).toString() else "NULL"
            buildList {
                add("($team, '2026-01-05', $md, $wip, $now, $now)")
                if (index % 3 == 0) add("($team, '2028-01-03', ${(md * 3 / 5).coerceAtLeast(6)}, $wip, $now, $now)")
            }
        }
        c.insert("team_capacity_periods", "team_id, effective_from, md_per_week, wip_limit, created_at, updated_at", rows)
    }

    /** Hard-deletes everything [seed] created under [prefix] (children first), safe to call after a failed or partial seed. */
    fun remove(prefix: String) {
        val teams = "SELECT id FROM teams WHERE name LIKE '$prefix-t%'"
        val milestones = "SELECT id FROM milestones WHERE team_id IN ($teams)"
        PostgresTestSupport.connect().use { c ->
            c.createStatement().use { st ->
                st.executeUpdate("DELETE FROM dependencies WHERE pred_milestone_id IN ($milestones) OR succ_milestone_id IN ($milestones)")
                st.executeUpdate("DELETE FROM milestones WHERE team_id IN ($teams)")
                st.executeUpdate("DELETE FROM team_capacity_periods WHERE team_id IN ($teams)")
                st.executeUpdate("DELETE FROM teams WHERE name LIKE '$prefix-t%'")
                st.executeUpdate("DELETE FROM projects WHERE name LIKE '$prefix-pj%'")
                st.executeUpdate("DELETE FROM programs WHERE name LIKE '$prefix-pg%'")
                st.executeUpdate("DELETE FROM work_streams WHERE name LIKE '$prefix-ws%'")
                st.executeUpdate("DELETE FROM people WHERE name = '$prefix-owner'")
            }
        }
    }

    /** Rows [seed] made that still carry [prefix] - streams to milestones, teams, capacity periods, links, the owner (0 after [remove]). */
    fun remaining(prefix: String): Int = PostgresTestSupport.connect().use { c ->
        c.createStatement().use { st ->
            val named = listOf("milestones" to "m", "teams" to "t", "projects" to "pj", "programs" to "pg", "work_streams" to "ws")
                .map { (table, tag) -> "(SELECT count(*) FROM $table WHERE name LIKE '$prefix-$tag%')" }
            val teams = "SELECT id FROM teams WHERE name LIKE '$prefix-t%'"
            val milestones = "SELECT id FROM milestones WHERE name LIKE '$prefix-m%'"
            val others = listOf(
                "(SELECT count(*) FROM team_capacity_periods WHERE team_id IN ($teams))",
                "(SELECT count(*) FROM dependencies WHERE pred_milestone_id IN ($milestones) OR succ_milestone_id IN ($milestones))",
                "(SELECT count(*) FROM people WHERE name = '$prefix-owner')",
            )
            st.executeQuery("SELECT ${(named + others).joinToString(" + ")}").use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }
    }

    private fun Connection.insert(table: String, columns: String, rows: List<String>) {
        createStatement().use { st ->
            rows.chunked(CHUNK).forEach { st.executeUpdate("INSERT INTO $table ($columns) VALUES ${it.joinToString(", ")}") }
        }
    }

    /** `name -> id` of the [table]'s rows whose name starts with [like] (a prefix unique to this seed). */
    private fun Connection.idsByName(table: String, like: String): Map<String, Int> {
        createStatement().use { st ->
            st.executeQuery("SELECT id, name FROM $table WHERE name LIKE '$like%'").use { rs ->
                return buildMap { while (rs.next()) put(rs.getString(2), rs.getInt(1)) }
            }
        }
    }
}
