package ch.nokillswit

import ch.nokillswit.jira.DeviationScope
import ch.nokillswit.jira.DeviationViewServiceKey
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.JiraLevelMapping
import ch.nokillswit.jira.JiraMapping
import ch.nokillswit.jira.JiraMappingLevels
import ch.nokillswit.jira.JiraStatusCategory
import ch.nokillswit.jira.toStoredJson
import ch.nokillswit.planning.Deviation
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.planning.loadWorkingCalendar
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.junit.After
import java.time.LocalDate
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The 1.4 coverage inputs of `GET /views/deviations` (unlinked Jira items, unlinked plan children, the epic roll-up) on a seeded world:
 * the census mirror rows are written through the store the run uses, the bindings and observations are raw INSERTs, nothing touches the
 * stub. The kernel's vectors are `JiraDeviationKernelsTest`; here the LOADERS: which rows count, the same-site rule, the mapping rule
 * and the equality of the scoped and the full computation.
 */
class DeviationCoverageTest {
    private val ledger = ConnectionLedger()

    @After
    fun dropConnections() = ledger.drop()

    private val done = JiraStatusCategory.DONE

    private fun nameOf(table: String, id: UInt) = TestPlan.scalar("SELECT name FROM $table WHERE id = $id") { it.getString(1) }

    private fun Collection<Deviation>.of(kind: DeviationKind) = singleOrNull { it.kind == kind }

    private suspend fun ApplicationTestBuilder.world(prefix: String): PlanWorld {
        usePostgresTestcontainer()
        return planWorld(prefix, teams = true)
    }

    @Test
    fun `a bound project lists unbound open epics as a warning and unbound milestones as an info, done and bound ones excluded`() =
        testApplication {
            val w = world("cov1")
            val c = ledger.track(w.admin.client.dvConnection())
            val team = w.requireTeams().teamId
            val project = TestPlan.project(w.programId, w.projectOwner.personId!!)
            val bound = TestPlan.milestone(project, team, planName("bound"))
            val unbound = TestPlan.milestone(project, team, planName("unbound"))
            // Three more plan children: a soft-deleted unbound one (not a child any more), one whose binding was released (unlinked
            // again) and one bound only through a DELETED connection (its binding is no cover).
            val dead = TestPlan.milestone(project, team, planName("dead"))
            val released = TestPlan.milestone(project, team, planName("released"))
            val viaDeleted = TestPlan.milestone(project, team, planName("viadeleted"))
            val deletedConnection = ledger.track(w.admin.client.dvConnection())
            jbSql("UPDATE milestones SET marked_as_deleted = TRUE WHERE id = ?", dead.toInt())
            val releasedBinding = dvBind(c, JiraLevel.MILESTONE, released, "9107", "COV-9107", DvObs(nameOf("milestones", released), 1))
            jbSql("UPDATE jira_bindings SET marked_as_deleted = TRUE WHERE id = ?", releasedBinding.toInt())
            dvBind(deletedConnection, JiraLevel.MILESTONE, viaDeleted, "9108", "COV-9108", DvObs("x", 1))
            jbSql("UPDATE jira_connections SET marked_as_deleted = TRUE WHERE id = ?", deletedConnection.toInt())
            val projectBinding = dvBind(c, JiraLevel.PROJECT, project, "9001", "COV-9001", DvObs(nameOf("projects", project), 2))
            dvBind(c, JiraLevel.MILESTONE, bound, "9101", "COV-9101", DvObs(nameOf("milestones", bound), 1))
            dvMirror(c, "9101", level = 1, parent = "9001")
            dvMirror(c, "9104", level = 1, parent = "9001", status = JiraStatusCategory.IN_PROGRESS)
            dvMirror(c, "9102", level = 1, parent = "9001")
            dvMirror(c, "9103", level = 1, parent = "9001", status = done)
            dvMirror(c, "9105", level = 0, parent = "9001") // a story under the project: not at the milestone level
            dvMirror(c, "9106", level = 1, parent = "8999") // under another parent

            val item = w.admin.client.dvView("connectionId=$c&all=true").byBinding().getValue(projectBinding)
            val inJira = assertNotNull(item.deviations.of(DeviationKind.UNLINKED_IN_JIRA))
            assertEquals(DeviationSeverity.WARNING, inJira.severity)
            assertEquals("COV-9102, COV-9104", inJira.detail.jira, "open and unbound only, ascending by issue id, keys never summaries")
            assertEquals(2, inJira.detail.count)
            assertNull(inJira.detail.plan)
            val inPlan = assertNotNull(item.deviations.of(DeviationKind.UNLINKED_IN_PLAN))
            assertEquals(DeviationSeverity.INFO, inPlan.severity)
            val expectedNames = listOf(unbound, released, viaDeleted).map { nameOf("milestones", it) }
            assertEquals(expectedNames.joinToString(", "), inPlan.detail.plan, "ascending by id; the deleted child is absent")
            assertEquals(3, inPlan.detail.count)
            assertNull(item.jira.rollup, "a project has no roll-up")
            assertTrue(w.admin.client.dvView("connectionId=$c").byBinding().containsKey(projectBinding), "and it is OPEN by default")
        }

    @Test
    fun `an epic's roll-up rides the item and raises CHILDREN_DONE when every child is done`() = testApplication {
        val w = world("cov2")
        val c = ledger.track(w.admin.client.dvConnection())
        val team = w.requireTeams().teamId
        val project = TestPlan.project(w.programId, w.projectOwner.personId!!)

        suspend fun epic(issue: String, status: String = "UNKNOWN"): UInt {
            val name = planName("ep")
            val id = TestPlan.milestone(project, team, name)
            TestPlan.schedule(id, "2044-02-01", "2044-02-04")
            return dvBind(c, JiraLevel.MILESTONE, id, issue, "COV-$issue", DvObs(name, 1, status, start = "2044-02-01", end = "2044-02-04"))
        }
        val mixed = epic("9201")
        val finished = epic("9202")
        val lonely = epic("9203")
        val epicDone = epic("9204", status = "DONE")
        val goneName = planName("ep")
        val goneMilestone = TestPlan.milestone(project, team, goneName)
        val goneObs = DvObs(goneName, 1, gone = true, goneReason = "DELETED")
        val goneEpic = dvBind(c, JiraLevel.MILESTONE, goneMilestone, "9205", "COV-9205", goneObs)
        dvMirror(c, "9251", 0, "9205", done)
        dvMirror(c, "9211", 0, "9201", done, "3", observedAt = 100)
        dvMirror(c, "9212", 0, "9201", done, "5", observedAt = 300)
        dvMirror(c, "9213", 0, "9201", JiraStatusCategory.TODO, null, observedAt = 200)
        dvMirror(c, "9214", 0, "9201", JiraStatusCategory.IN_PROGRESS, "2.5", observedAt = 150)
        dvMirror(c, "9221", 0, "9202", done)
        dvMirror(c, "9222", 0, "9202", done)
        dvMirror(c, "9241", 0, "9204", done)

        val items = w.admin.client.dvView("connectionId=$c&all=true").byBinding()
        val rollup = assertNotNull(items.getValue(mixed).jira.rollup)
        assertEquals(listOf(4, 2, 10.5, 300L), listOf(rollup.children, rollup.done, rollup.points, rollup.observedAt))
        assertEquals(emptySet(), items.getValue(mixed).kindSet(), "2 of 4 done raises nothing")
        val allDone = assertNotNull(items.getValue(finished).jira.rollup)
        assertEquals(listOf(2, 2, null), listOf(allDone.children, allDone.done, allDone.points), "no child carries points: null")
        val children = assertNotNull(items.getValue(finished).deviations.of(DeviationKind.CHILDREN_DONE))
        assertEquals(DeviationSeverity.INFO, children.severity)
        assertEquals(listOf("2/2", "2044-02-04", 2), listOf(children.detail.jira, children.detail.plan, children.detail.count))
        assertNull(items.getValue(lonely).jira.rollup, "an epic with no mirrored child has no roll-up")
        assertEquals(setOf(DeviationKind.PROGRESS_MISMATCH), items.getValue(epicDone).kindSet(), "a DONE epic is PROGRESS_MISMATCH alone")
        assertEquals(1, items.getValue(epicDone).jira.rollup?.children)
        assertEquals(setOf(DeviationKind.GONE), items.getValue(goneEpic).kindSet())
        assertNull(items.getValue(goneEpic).jira.rollup, "a gone issue carries no stale roll-up beside GONE")
    }

    @Test
    fun `a child bound on another active connection of the same site is linked (D1), a deleted connection or another site is not`() =
        testApplication {
            val w = world("cov3")
            val admin = w.admin.client
            val c = ledger.track(admin.dvConnection())
            val sameSite = ledger.track(admin.dvConnection())
            val deleted = ledger.track(admin.dvConnection())
            val elsewhere = ledger.track(admin.dvConnection())
            val site = jbScalar("SELECT site_url FROM jira_connections WHERE id = ?", c.toInt()) { it.getString(1) }
            listOf(sameSite, deleted).forEach { jbSql("UPDATE jira_connections SET site_url = ? WHERE id = ?", site, it.toInt()) }
            val team = w.requireTeams().teamId
            val project = TestPlan.project(w.programId, w.projectOwner.personId!!)
            val elsewhereProject = TestPlan.project(w.programId, w.projectOwner.personId!!)
            val projectBinding = dvBind(c, JiraLevel.PROJECT, project, "9301", "COV-9301", DvObs(nameOf("projects", project), 2))
            suspend fun bindElsewhere(connection: UInt, issue: String) =
                dvBind(connection, JiraLevel.MILESTONE, TestPlan.milestone(elsewhereProject, team), issue, "COV-$issue", DvObs("x"))
            bindElsewhere(sameSite, "9302")
            bindElsewhere(deleted, "9303")
            bindElsewhere(elsewhere, "9304")
            jbSql("UPDATE jira_connections SET marked_as_deleted = TRUE WHERE id = ?", deleted.toInt())
            listOf("9302", "9303", "9304", "9305").forEach { dvMirror(c, it, level = 1, parent = "9301") }

            val item = admin.dvView("connectionId=$c&all=true").byBinding().getValue(projectBinding)
            val inJira = assertNotNull(item.deviations.of(DeviationKind.UNLINKED_IN_JIRA))
            assertEquals("COV-9303, COV-9304, COV-9305", inJira.detail.jira)
            assertEquals(3, inJira.detail.count)
        }

    @Test
    fun `a program's coverage lists unbound projects, and with the child plan level unmapped no coverage is raised`() = testApplication {
        val w = world("cov4")
        val admin = w.admin.client
        val c = ledger.track(admin.dvConnection())
        val noProjects = JiraMapping(
            JiraMappingLevels(program = JiraLevelMapping(3), milestone = JiraLevelMapping(1)), DV_MAPPING.estimate,
        ).toStoredJson()
        val unmapped = ledger.track(admin.dvConnection(mapping = noProjects))
        val owner = w.projectOwner.personId!!

        suspend fun program(connection: UInt, issue: String): Pair<UInt, String> {
            val program = TestPlan.program(w.streamId, w.programOwner.personId!!)
            TestPlan.project(program, owner, planName("lone"))
            val unlinked = TestPlan.project(program, owner, planName("pj-unlinked"))
            val linked = TestPlan.project(program, owner, planName("pj-linked"))
            dvBind(connection, JiraLevel.PROJECT, linked, "${issue}2", "COV-${issue}2", DvObs(nameOf("projects", linked), 2))
            dvMirror(connection, "${issue}2", level = 2, parent = issue)
            dvMirror(connection, "${issue}3", level = 2, parent = issue)
            val binding = dvBind(connection, JiraLevel.PROGRAM, program, issue, "COV-$issue", DvObs(nameOf("programs", program), 3))
            return binding to nameOf("projects", unlinked)
        }
        val (mapped, _) = program(c, "9401")
        val (unmappedBinding, _) = program(unmapped, "9501")

        val item = admin.dvView("all=true").byBinding().getValue(mapped)
        assertEquals("COV-94013", assertNotNull(item.deviations.of(DeviationKind.UNLINKED_IN_JIRA)).detail.jira)
        val inPlan = assertNotNull(item.deviations.of(DeviationKind.UNLINKED_IN_PLAN))
        assertEquals(2, inPlan.detail.count, "the lone project and the unlinked one; the linked one is covered")
        assertNull(admin.dvView("all=true").byBinding().getValue(unmappedBinding).deviations.of(DeviationKind.UNLINKED_IN_JIRA))
        assertNull(admin.dvView("all=true").byBinding().getValue(unmappedBinding).deviations.of(DeviationKind.UNLINKED_IN_PLAN))
    }

    @Test
    fun `the scoped computation equals the full one for the new kinds, and so does the single binding the acknowledge recomputes`() =
        testApplication {
            val w = world("cov5")
            val c = ledger.track(w.admin.client.dvConnection())
            val team = w.requireTeams().teamId
            val owner = w.projectOwner.personId!!
            val program = TestPlan.program(w.streamId, w.programOwner.personId!!)
            val project = TestPlan.project(program, owner)
            TestPlan.project(program, owner) // unbound: UNLINKED_IN_PLAN on the program
            TestPlan.milestone(project, team) // unbound: UNLINKED_IN_PLAN on the project
            val epicName = planName("ep")
            val epic = TestPlan.milestone(project, team, epicName)
            TestPlan.schedule(epic, "2044-02-01", "2044-02-04")
            val bProgram = dvBind(c, JiraLevel.PROGRAM, program, "9601", "COV-9601", DvObs(nameOf("programs", program), 3))
            val projectObs = DvObs(nameOf("projects", project), 2, parentId = "9601")
            val bProject = dvBind(c, JiraLevel.PROJECT, project, "9602", "COV-9602", projectObs)
            val epicObs = DvObs(epicName, 1, start = "2044-02-01", end = "2044-02-04")
            val bEpic = dvBind(c, JiraLevel.MILESTONE, epic, "9603", "COV-9603", epicObs)
            dvMirror(c, "9610", 2, "9601")
            dvMirror(c, "9611", 1, "9602")
            dvMirror(c, "9612", 0, "9603", done)

            val service = application.attributes[DeviationViewServiceKey]
            suspend fun fingerprints(scope: DeviationScope) = suspendTransaction(sharedDatabaseForTests()) {
                service.computeInTransaction(scope, null, loadWorkingCalendar(), LocalDate.now(ZoneOffset.UTC)).candidates
                    .associate { it.bindingId to it.item.fingerprint }
            }
            val full = fingerprints(DeviationScope(connectionId = c))
            assertEquals(setOf(bProgram, bProject, bEpic), full.keys)
            val kinds = w.admin.client.dvView("connectionId=$c&all=true").byBinding()
            val coverageKinds = setOf(DeviationKind.UNLINKED_IN_JIRA, DeviationKind.UNLINKED_IN_PLAN)
            assertTrue(kinds.getValue(bProgram).kindSet().containsAll(coverageKinds))
            assertTrue(DeviationKind.UNLINKED_IN_JIRA in kinds.getValue(bProject).kindSet())
            assertTrue(DeviationKind.CHILDREN_DONE in kinds.getValue(bEpic).kindSet())
            val timelineFold = fingerprints(DeviationScope(connectionId = c, levels = setOf(JiraLevel.PROJECT, JiraLevel.MILESTONE)))
            assertEquals(full - bProgram, timelineFold, "the fold's whole-plan scope: never a program")
            assertEquals(mapOf(bEpic to full.getValue(bEpic)), fingerprints(DeviationScope(milestoneIds = listOf(epic))))
            for ((binding, fingerprint) in full) {
                val single = fingerprints(DeviationScope(connectionId = c, bindingId = binding))
                assertEquals(mapOf(binding to fingerprint), single, "binding $binding")
                assertEquals(fingerprint, kinds.getValue(binding).fingerprint, "the view's own fingerprint")
            }
        }
}
