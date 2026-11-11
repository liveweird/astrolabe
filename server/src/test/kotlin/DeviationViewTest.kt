package ch.nokillswit

import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.planning.DeviationSeverity
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/deviations` through the wire on a seeded world: every kind, `all`, the filters, the order and the 400s. Observations are
 * seeded straight into the table (no stub); the real clock is "today", and every plan date is in 2044, so the progress rules are
 * stable. [DV_MONDAY] (2044-02-01) is a Monday: the week is 02-01 .. 02-05, the next 02-08 .. 02-12.
 */
class DeviationViewTest {
    private suspend fun ApplicationTestBuilder.start() {
        usePostgresTestcontainer()
    }

    private class Nodes(val w: PlanWorld) {
        val team = w.requireTeams().teamId
        val otherTeam = w.requireTeams().otherTeamId

        /** An unscheduled milestone, or one scheduled [start]..[end] (ISO). */
        suspend fun milestone(
            prefix: String,
            start: String? = null,
            end: String? = null,
            project: UInt = w.projectId,
            estimate: Double = 2.0,
            team: UInt = this.team,
        ): Pair<UInt, String> {
            val name = planName(prefix)
            val id = TestPlan.milestone(project, team, name, estimate)
            if (start != null && end != null) TestPlan.schedule(id, start, end)
            return id to name
        }
    }

    @Test
    fun `a gone binding reads OUT_OF_SCOPE until probed, then MOVED_OUT or NOT_LISTED, the verdicts stay as stored`() = testApplication {
        start()
        val w = planWorld("dvmo", teams = true)
        val n = Nodes(w)
        val c = w.admin.client.dvConnection()
        suspend fun gone(issue: Int, reason: String, probedAt: Long?, probedKey: String? = null): UInt {
            val (id, name) = n.milestone("mo$issue", "2044-02-01", "2044-02-04")
            val obs = DvObs(name, 1, gone = true, goneReason = reason, goneProbedAt = probedAt, goneProbedKey = probedKey)
            return dvBind(c, JiraLevel.MILESTONE, id, issue.toString(), "ABC-$issue", obs)
        }
        val sweep = gone(8101, "OUT_OF_SCOPE", null)
        val probed = gone(8102, "OUT_OF_SCOPE", 5)
        val deleted = gone(8103, "DELETED", 5)
        val forbidden = gone(8104, "FORBIDDEN", 5)
        val outside = gone(8105, "OUT_OF_SCOPE", 5, "OUT-3") // the connection's keys are E2E
        val inside = gone(8106, "OUT_OF_SCOPE", 5, "E2E-3")
        val view = w.admin.client.dvView("connectionId=$c")
        fun reason(id: UInt) = assertNotNull(view.byBinding()[id]).deviations.single().also { assertEquals(DeviationKind.GONE, it.kind) }
            .detail.jira
        assertEquals(
            listOf("OUT_OF_SCOPE", "MOVED_OUT", "DELETED", "FORBIDDEN", "MOVED_OUT", "NOT_LISTED"),
            listOf(sweep, probed, deleted, forbidden, outside, inside).map(::reason),
            "no key reads moved out (1.12's inference), a key outside the connection's keys moved out, one inside not listed",
        )
        assertEquals(6, view.totals.gone, "a moved-out or not-listed item still counts as gone from Jira")
        assertEquals(
            3, view.totals.stillInJira,
            "the three moved-out or not-listed ones (a key-less probe included) are still in Jira, not the deleted, forbidden or unprobed",
        )
    }

    @Test
    fun `every kind comes through the wire with its severity and detail, and the view moves no revision`() = testApplication {
        start()
        val w = planWorld("dvk", teams = true)
        val n = Nodes(w)
        val c = w.admin.client.dvConnection()
        val other = w.admin.client.dvConnection()

        // A second project of the program (bound to issue 7001 on c) with a target window and one scheduled milestone.
        val sName = planName("pj-s")
        val sId = TestPlan.project(w.programId, w.projectOwner.personId!!, sName, "2044-02-01", "2044-02-12")
        n.milestone("s-ms", "2044-02-02", "2044-02-05", project = sId)
        val projectBinding = dvBind(c, JiraLevel.PROJECT, sId, "7001", "ABC-1", DvObs(sName, 2, start = "2044-02-01", end = "2044-02-05"))
        // A program with one project with one milestone scheduled 02-02..02-05: its span is DERIVED from them.
        val q = TestPlan.program(w.streamId, w.programOwner.personId!!)
        val qProject = TestPlan.project(q, w.projectOwner.personId)
        n.milestone("q-ms", "2044-02-02", "2044-02-05", project = qProject)
        val qName = TestPlan.scalar("SELECT name FROM programs WHERE id = $q") { it.getString(1) }
        val programBinding = dvBind(c, JiraLevel.PROGRAM, q, "7100", "ABC-100", DvObs(qName, 3, start = "2044-02-01", end = "2044-02-04"))

        fun aligned(name: String, start: String = "2044-02-01", end: String = "2044-02-04") = DvObs(name, 1, start = start, end = end)
        suspend fun bound(
            prefix: String,
            issue: Int,
            obs: (String) -> DvObs,
            start: String? = "2044-02-01",
            end: String? = "2044-02-04",
            estimate: Double = 2.0,
        ): UInt {
            val (id, name) = n.milestone(prefix, start, end, estimate = estimate)
            return dvBind(c, JiraLevel.MILESTONE, id, issue.toString(), "ABC-$issue", obs(name))
        }

        val gone = bound(
            "gone", 8001,
            { DvObs("stale", 0, "DONE", "7001", "ABC-1", "2044-03-01", "2044-03-04", gone = true, goneReason = "OUT_OF_SCOPE") },
        )
        val level = bound("level", 8002, { DvObs(it, 0, start = "2044-02-01", end = "2044-02-04") })
        val parent = bound(
            "parent", 8003, { DvObs(it, 1, parentId = "7001", parentKey = "ABC-1", start = "2044-02-01", end = "2044-02-04") },
        )
        val renamed = bound("renamed", 8004, { DvObs("Renamed", 1, start = "2044-02-01", end = "2044-02-04") })
        val dates = bound("dates", 8005, { DvObs(it, 1, start = "2044-02-01", end = "2044-02-05") }, "2044-02-02", "2044-02-09")
        val unschedPlan = bound("unplan", 8006, { DvObs(it, 1, start = "2044-02-01", end = "2044-02-04") }, null, null)
        val unschedJira = bound("unjira", 8007, { DvObs(it, 1) })
        val estimate = bound(
            "est", 8008, { DvObs(it, 1, start = "2044-02-01", end = "2044-02-04", estimate = "21.00", unit = "POINTS") }, estimate = 8.0,
        )
        val progress = bound("prog", 8009, { DvObs(it, 1, "DONE", start = "2044-02-01", end = "2044-02-04") })
        val notComparable = bound("nc", 8010, { DvObs(it, 1, start = "2044-02-01", end = "2044-02-04", estimate = "5.00", unit = "DAYS") })
        val clean = bound("clean", 8011, { aligned(it) })
        // A parent issue bound only on ANOTHER connection is no parent here: nothing is raised.
        val (elsewhere, _) = n.milestone("else", "2044-02-01", "2044-02-04")
        dvBind(other, JiraLevel.MILESTONE, elsewhere, "7002", "ABC-2", DvObs("whatever"))
        val scoped = bound(
            "scoped", 8012, { DvObs(it, 1, parentId = "7002", parentKey = "ABC-2", start = "2044-02-01", end = "2044-02-04") },
        )

        val revisionBefore = TestPlan.revision()
        val view = w.admin.client.dvView("connectionId=$c")
        assertTrue(Regex("""\d{4}-\d{2}-\d{2}""").matches(view.asOf))
        assertEquals(revisionBefore, view.revision, "the plan's revision, as it stood")
        val items = view.byBinding()
        fun kinds(id: UInt) = assertNotNull(items[id], "binding $id is listed").kindSet()

        assertEquals(setOf(DeviationKind.GONE), kinds(gone), "a gone issue raises GONE alone")
        assertEquals(setOf(DeviationKind.LEVEL_MISMATCH), kinds(level))
        assertEquals(setOf(DeviationKind.PARENT_MISMATCH), kinds(parent))
        assertEquals(setOf(DeviationKind.RENAMED), kinds(renamed))
        assertEquals(setOf(DeviationKind.START_DIFFERS, DeviationKind.END_DIFFERS), kinds(dates))
        assertEquals(setOf(DeviationKind.UNSCHEDULED_IN_PLAN), kinds(unschedPlan))
        assertEquals(setOf(DeviationKind.UNSCHEDULED_IN_JIRA), kinds(unschedJira))
        assertEquals(setOf(DeviationKind.ESTIMATE_DIFFERS), kinds(estimate))
        assertEquals(setOf(DeviationKind.PROGRESS_MISMATCH), kinds(progress))
        assertEquals(
            setOf(DeviationKind.START_DIFFERS, DeviationKind.TARGET_DIFFERS, DeviationKind.UNLINKED_IN_PLAN), kinds(projectBinding),
            "a project: derived span and target window, and its unbound milestone (1.4)",
        )
        assertEquals(
            setOf(DeviationKind.START_DIFFERS, DeviationKind.END_DIFFERS, DeviationKind.UNLINKED_IN_PLAN), kinds(programBinding),
            "a program: the derived span of its projects, and its unbound project (1.4)",
        )
        listOf(notComparable, clean, scoped).forEach { assertTrue(it !in items, "not listed by default") }

        // The detail and severity of a few.
        val dateItem = items.getValue(dates)
        assertEquals(listOf(DeviationSeverity.WARNING, DeviationSeverity.WARNING), dateItem.deviations.map { it.severity })
        assertEquals(1, dateItem.deviations.single { it.kind == DeviationKind.START_DIFFERS }.detail.days)
        assertEquals(2, dateItem.deviations.single { it.kind == DeviationKind.END_DIFFERS }.detail.days, "Fri 02-05 -> Tue 02-09")
        val estimateDetail = items.getValue(estimate).deviations.single().detail
        assertEquals("10.50" to "8.00", estimateDetail.jira to estimateDetail.plan)
        val projectItem = items.getValue(projectBinding)
        assertEquals("2044-02-02" to "2044-02-05", projectItem.plan.spanStart to projectItem.plan.spanEnd)
        assertEquals("2044-02-01" to "2044-02-12", projectItem.plan.targetStart to projectItem.plan.targetEnd)
        assertEquals(DeviationSeverity.INFO, projectItem.deviations.single { it.kind == DeviationKind.START_DIFFERS }.severity)
        assertEquals(5, projectItem.deviations.single { it.kind == DeviationKind.TARGET_DIFFERS }.detail.days)
        val programItem = items.getValue(programBinding)
        assertEquals(DeviationSeverity.WARNING, programItem.deviations.first().severity, "the plan's end is later than Jira's")
        assertEquals("2044-02-02" to "2044-02-05", programItem.plan.spanStart to programItem.plan.spanEnd)
        assertNull(items.getValue(dates).plan.spanStart, "a milestone has no derived span")
        assertEquals("ABC-1", items.getValue(parent).deviations.single().detail.jira)
        val parentName = TestPlan.scalar("SELECT name FROM projects WHERE id = ${w.projectId}") { it.getString(1) }
        assertEquals(parentName, items.getValue(parent).deviations.single().detail.plan, "the plan parent is the milestone's project")
        assertEquals(n.team, items.getValue(dates).node.teamId)
        assertEquals(w.projectId, items.getValue(dates).node.projectId)

        // Totals count the filtered bindings' deviations: 7 warnings, 9 infos (two are the 1.4 UNLINKED_IN_PLAN of the project and the
        // program) over 11 bindings, 1 gone.
        assertEquals(listOf(7, 9, 11, 1), view.totals.let { listOf(it.warnings, it.infos, it.bindings, it.gone) })
        assertTrue(!view.truncated)

        // `all=true` adds the clean bindings and ESTIMATE_NOT_COMPARABLE; `kind=` naming it lists it without `all`.
        val everything = w.admin.client.dvView("connectionId=$c&all=true").byBinding()
        assertEquals(setOf(DeviationKind.ESTIMATE_NOT_COMPARABLE), everything.getValue(notComparable).kindSet())
        assertEquals("5.00", everything.getValue(notComparable).deviations.single().detail.jira, "the raw figure, never converted")
        assertEquals(emptySet(), everything.getValue(clean).kindSet())
        assertEquals(
            emptySet(), everything.getValue(scoped).kindSet(), "an unbound parent (here: bound on another connection) raises nothing",
        )
        assertEquals(items.keys + setOf(notComparable, clean, scoped), everything.keys)
        assertEquals(
            setOf(notComparable), w.admin.client.dvView("connectionId=$c&kind=ESTIMATE_NOT_COMPARABLE").items.map { it.bindingId }.toSet(),
        )
        assertEquals(revisionBefore, TestPlan.revision(), "the view moved no revision")
    }

    @Test
    fun `a holiday moves the working-day shift through the wire`() = testApplication {
        start()
        val w = planWorld("dvh", teams = true)
        val n = Nodes(w)
        val c = w.admin.client.dvConnection()
        val (id, name) = n.milestone("hol", "2044-02-03", "2044-02-05")
        val binding = dvBind(c, JiraLevel.MILESTONE, id, "8101", "ABC-8101", DvObs(name, 1, start = "2044-02-01", end = "2044-02-05"))
        assertEquals(
            2, w.admin.client.dvView("connectionId=$c").byBinding().getValue(binding).deviations.single().detail.days, "Mon -> Wed",
        )
        TestHolidays.with("2044-02-02") {
            assertEquals(
                1, w.admin.client.dvView("connectionId=$c").byBinding().getValue(binding).deviations.single().detail.days, "Tuesday is off",
            )
        }
    }

    @Test
    fun `with the project level unmapped a milestone's parent is its program - no false PARENT_MISMATCH`() = testApplication {
        start()
        val w = planWorld("dvu", teams = true)
        val n = Nodes(w)
        val noProjectLevel = """{"levels":{"program":{"hierarchyLevel":3},"milestone":{"hierarchyLevel":1}}}"""
        val c = w.admin.client.dvConnection(mapping = noProjectLevel)
        val programName = TestPlan.scalar("SELECT name FROM programs WHERE id = ${w.programId}") { it.getString(1) }
        dvBind(c, JiraLevel.PROGRAM, w.programId, "7200", "ABC-7200", DvObs(programName, 3))
        val otherProgram = TestPlan.program(w.streamId, w.programOwner.personId!!)
        val otherName = TestPlan.scalar("SELECT name FROM programs WHERE id = $otherProgram") { it.getString(1) }
        dvBind(c, JiraLevel.PROGRAM, otherProgram, "7201", "ABC-7201", DvObs(otherName, 3))

        suspend fun epic(parentIssue: String): UInt {
            val (id, name) = n.milestone("up")
            val obs = DvObs(name, 1, parentId = parentIssue, parentKey = "ABC-$parentIssue")
            return dvBind(c, JiraLevel.MILESTONE, id, "72$parentIssue", "ABC-72$parentIssue", obs)
        }
        val underItsProgram = epic("7200")
        val underAnotherProgram = epic("7201")
        val items = w.admin.client.dvView("connectionId=$c&all=true").byBinding()
        assertEquals(emptySet(), items.getValue(underItsProgram).kindSet(), "the Epic's parent is bound to the milestone's own program")
        assertEquals(
            setOf(DeviationKind.PARENT_MISMATCH), items.getValue(underAnotherProgram).kindSet(), "bound to ANOTHER program: a real one",
        )
        assertEquals(programName, items.getValue(underItsProgram).node.programName)
    }

    @Test
    fun `a chip's implied all does not switch ESTIMATE_NOT_COMPARABLE on - only an explicit all or the kind does`() = testApplication {
        start()
        val w = planWorld("dvn", teams = true)
        val n = Nodes(w)
        val c = w.admin.client.dvConnection(mapping = null) // the defaults: POINTS and no factor, so every figure is "not comparable"
        val bindings = (1..3).map { i ->
            val (id, name) = n.milestone("nc")
            dvBind(c, JiraLevel.MILESTONE, id, "73$i", "ABC-73$i", DvObs(name, 1, estimate = "5.00", unit = "POINTS"))
        }
        val chip = w.admin.client.dvView("connectionId=$c&projectId=${w.projectId}")
        assertEquals(bindings.toSet(), chip.items.map { it.bindingId }.toSet(), "projectId alone implies all: clean ones are listed")
        assertTrue(chip.items.all { it.deviations.isEmpty() })
        assertEquals(listOf(0, 0, 3), listOf(chip.totals.warnings, chip.totals.infos, chip.totals.bindings))
        val team = w.admin.client.dvView("connectionId=$c&teamId=${n.team}")
        assertEquals(0, team.totals.infos)
        val explicit = w.admin.client.dvView("connectionId=$c&projectId=${w.projectId}&all=true")
        assertEquals(3, explicit.totals.infos)
        assertTrue(explicit.items.all { it.kindSet() == setOf(DeviationKind.ESTIMATE_NOT_COMPARABLE) })
        assertEquals(3, w.admin.client.dvView("connectionId=$c&kind=ESTIMATE_NOT_COMPARABLE").items.size)
    }

    // --- filters ----------------------------------------------------------------------------------------------------------------------

    @Test
    fun `every filter narrows the bindings, and projectId and teamId imply all unless all=false says otherwise`() = testApplication {
        start()
        val w = planWorld("dvf", teams = true)
        val n = Nodes(w)
        val c = w.admin.client.dvConnection()
        val j2 = TestPlan.project(w.programId, w.projectOwner.personId!!)
        val stream2 = TestPlan.workStream(w.streamOwner.personId!!)
        val program2 = TestPlan.program(stream2, w.programOwner.personId!!)
        val j3 = TestPlan.project(program2, w.projectOwner.personId)
        var issue = 9000

        suspend fun ms(project: UInt, team: UInt, obs: (String) -> DvObs): UInt {
            val (id, name) = n.milestone("f", "2044-02-01", "2044-02-04", project = project, team = team)
            issue += 1
            return dvBind(c, JiraLevel.MILESTONE, id, "$issue", "ABC-$issue", obs(name))
        }
        val warn = { name: String -> DvObs(name, 0, start = "2044-02-01", end = "2044-02-04") }
        val info = { _: String -> DvObs("Renamed", 1, start = "2044-02-01", end = "2044-02-04") }
        val clean = { name: String -> DvObs(name, 1, start = "2044-02-01", end = "2044-02-04") }

        val a1 = ms(w.projectId, n.team, warn)
        val a2 = ms(w.projectId, n.otherTeam, info)
        val a3 = ms(w.projectId, n.team, clean)
        val b1 = ms(j2, n.team, info)
        val c1 = ms(j3, n.otherTeam, warn)
        val projectJ1 = dvBind(c, JiraLevel.PROJECT, w.projectId, "9500", "ABC-9500", DvObs("Renamed", 2))

        suspend fun ids(query: String) = w.admin.client.dvView("connectionId=$c&$query").items.map { it.bindingId }.toSet()

        assertEquals(setOf(a1, a2, b1, c1, projectJ1), ids(""), "default: deviating bindings only")
        assertEquals(setOf(a1, a2, a3, b1, c1, projectJ1), ids("all=true"))
        assertEquals(setOf(projectJ1), ids("level=PROJECT"))
        assertEquals(setOf(a1, c1), ids("severity=WARNING"))
        assertEquals(setOf(a2, b1, projectJ1), ids("severity=INFO"))
        assertEquals(setOf(a2, b1, projectJ1), ids("kind=RENAMED"))
        assertEquals(setOf(a1, c1), ids("kind=LEVEL_MISMATCH&all=true"), "kind keeps only bindings having it, all or not")
        assertEquals(setOf(a1, a2, b1, projectJ1), ids("workStreamId=${w.streamId}"))
        assertEquals(setOf(c1), ids("workStreamId=$stream2"))
        assertEquals(setOf(a1, a2, b1, projectJ1), ids("programId=${w.programId}"))
        assertEquals(setOf(c1), ids("programId=$program2"))
        assertEquals(
            setOf(a1, a2, a3, projectJ1), ids("projectId=${w.projectId}"), "a project filter implies all: the project and its milestones",
        )
        assertEquals(setOf(a1, a2, projectJ1), ids("projectId=${w.projectId}&all=false"))
        assertEquals(setOf(a1, a3, b1), ids("teamId=${n.team}"), "a team filter implies all; a project node has no team")
        assertEquals(setOf(a2, c1), ids("teamId=${n.otherTeam}"))
        assertEquals(setOf(a1, b1), ids("teamId=${n.team}&all=false"))
        assertEquals(setOf(a1, a3), ids("projectId=${w.projectId}&teamId=${n.team}"))
        assertEquals(setOf(a1), ids("severity=WARNING&workStreamId=${w.streamId}"))
        val warnings = w.admin.client.dvView("connectionId=$c&severity=WARNING")
        assertEquals(
            listOf(2, 0, 2, 0), listOf(warnings.totals.warnings, warnings.totals.infos, warnings.totals.bindings, warnings.totals.gone),
        )
        assertEquals(0, w.admin.client.dvView("connectionId=${c + 1000u}").items.size)
    }

    @Test
    fun `a repeated key, an unknown enum and a malformed id or boolean are each a 400`() = testApplication {
        start()
        val client = seededClient("dvbad")
        for (query in listOf(
            "level=MILESTONE&level=PROJECT", "connectionId=1&connectionId=2", "all=true&all=false", "kind=RENAMED&kind=GONE",
            "connectionId=abc", "connectionId=-1", "workStreamId=x", "programId=1.5", "projectId=", "teamId=%20x",
            "all=yes", "all=1", "level=EPIC", "severity=ERROR", "kind=NOPE", "kind=renamed",
        )) {
            val expected = if (query == "projectId=") HttpStatusCode.OK else HttpStatusCode.BadRequest
            assertEquals(expected, client.get("$DV_VIEW?$query").status, query)
        }
        // Unknown parameter NAMES are ignored by deliberate leniency.
        assertEquals(HttpStatusCode.OK, client.get("$DV_VIEW?nonsense=1").status)
        val problem = client.get("$DV_VIEW?level=EPIC")
        assertTrue(problem.bodyAsText().contains("level"), "the 400 names the parameter")
    }

    // --- order ------------------------------------------------------------------------------------------------------------------------

    @Test
    fun `warnings come first, then work stream, program, project, level and name - case-insensitively`() = testApplication {
        start()
        val w = planWorld("dvo", teams = true)
        val n = Nodes(w)
        val c = w.admin.client.dvConnection()
        val first = TestPlan.workStream(w.streamOwner.personId!!, planName("0-first"))
        val firstProgram = TestPlan.program(first, w.programOwner.personId!!, planName("0-pg"))
        val firstProject = TestPlan.project(firstProgram, w.projectOwner.personId!!, planName("0-pj"))
        val zzz = TestPlan.project(w.programId, w.projectOwner.personId, planName("zzz"))
        val aaa = TestPlan.project(w.programId, w.projectOwner.personId, planName("AAA"))
        var issue = 9600

        suspend fun ms(project: UInt, name: String, obs: (String) -> DvObs): UInt {
            val id = TestPlan.milestone(project, n.team, name)
            issue += 1
            return dvBind(c, JiraLevel.MILESTONE, id, "$issue", "ABC-$issue", obs(name))
        }
        val info = { _: String -> DvObs("Renamed", 1) }
        val warn = { name: String -> DvObs(name, 0) }

        val warnLate = ms(zzz, planName("m"), warn)
        val inZzzB = ms(zzz, "b-" + planName("m"), info)
        val inZzzA = ms(zzz, "A-" + planName("m"), info)
        val inAaa = ms(aaa, planName("m"), info)
        val inFirst = ms(firstProject, planName("m"), info)
        val aaaProject = dvBind(c, JiraLevel.PROJECT, aaa, "9700", "ABC-9700", DvObs("Renamed", 2))
        val programBinding = dvBind(c, JiraLevel.PROGRAM, firstProgram, "9701", "ABC-9701", DvObs("Renamed", 3))

        val order = w.admin.client.dvView("connectionId=$c").items.map { it.bindingId }
        // The WARNING first whatever its place; then the "0-first" stream (its program, then its project); then the world's stream, whose
        // projects sort AAA < zzz case-insensitively, a project's own row before its milestones, milestones A- < b-.
        assertEquals(listOf(warnLate, programBinding, inFirst, aaaProject, inAaa, inZzzA, inZzzB), order)
        assertEquals(DeviationSeverity.WARNING, w.admin.client.dvView("connectionId=$c").items.first().deviations.first().severity)
    }
}
