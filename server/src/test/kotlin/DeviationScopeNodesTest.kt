package ch.nokillswit

import ch.nokillswit.jira.DeviationScope
import ch.nokillswit.jira.DeviationViewServiceKey
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.planning.loadWorkingCalendar
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.junit.After
import java.time.LocalDate
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The node-list fields of `DeviationScope` (`programIds`, `projectIds`, `milestoneIds`) and `levels`, the narrowing the timeline fold
 * reads through: a binding on ANY named node matches, an EMPTY named list names nothing (never "everything", and valid SQL), an
 * unknown id matches nothing, a dead node stays hidden, and the narrowed computation equals the full one for the bindings it reads.
 */
class DeviationScopeNodesTest {
    private val ledger = ConnectionLedger()

    @After
    fun dropConnections() = ledger.drop()

    /** One program, two projects (`pj`, `pj2`), three milestones (`m1`, `m2` under `pj`; `m3` under `pj2`), one binding on each node. */
    private class Bound(
        val w: PlanWorld,
        val c: UInt,
        val pj2: UInt,
        val m1: UInt,
        val m2: UInt,
        val m3: UInt,
        val bProgram: UInt,
        val bProject: UInt,
        val b1: UInt,
        val b2: UInt,
        val b3: UInt,
    ) {
        val program = w.programId
        val pj = w.projectId
        val everything get() = setOf(bProgram, bProject, b1, b2, b3)
    }

    private suspend fun ApplicationTestBuilder.world(prefix: String): Bound {
        usePostgresTestcontainer()
        val w = planWorld(prefix, teams = true)
        val c = ledger.track(w.admin.client.dvConnection())
        val team = w.requireTeams().teamId
        val pj2 = TestPlan.project(w.programId, w.projectOwner.personId!!)
        val m1 = TestPlan.milestone(w.projectId, team)
        val m2 = TestPlan.milestone(w.projectId, team)
        val m3 = TestPlan.milestone(pj2, team)
        return Bound(
            w, c, pj2, m1, m2, m3,
            bProgram = deviatingBinding(c, JiraLevel.PROGRAM, w.programId),
            bProject = deviatingBinding(c, JiraLevel.PROJECT, w.projectId),
            b1 = deviatingBinding(c, JiraLevel.MILESTONE, m1),
            b2 = deviatingBinding(c, JiraLevel.MILESTONE, m2),
            b3 = deviatingBinding(c, JiraLevel.MILESTONE, m3),
        )
    }

    private suspend fun ApplicationTestBuilder.bindingsOf(scope: DeviationScope): Set<UInt> {
        val service = application.attributes[DeviationViewServiceKey]
        val asOf = LocalDate.now(ZoneOffset.UTC)
        return suspendTransaction(sharedDatabaseForTests()) {
            service.computeInTransaction(scope, null, loadWorkingCalendar(), asOf).candidates.map { it.bindingId }.toSet()
        }
    }

    @Test
    fun `named nodes match a binding on ANY of them, per kind and across kinds, and nothing else`() = testApplication {
        val b = world("dsn1")
        fun scope(
            programs: List<UInt>? = null,
            projects: List<UInt>? = null,
            milestones: List<UInt>? = null,
            levels: Set<JiraLevel>? = null,
        ) = DeviationScope(connectionId = b.c, programIds = programs, projectIds = projects, milestoneIds = milestones, levels = levels)

        assertEquals(b.everything, bindingsOf(scope()), "no restriction on any axis: every binding of the connection")
        assertEquals(setOf(b.bProgram), bindingsOf(scope(programs = listOf(b.program))))
        assertEquals(setOf(b.bProject), bindingsOf(scope(projects = listOf(b.pj))))
        assertEquals(setOf(b.b1), bindingsOf(scope(milestones = listOf(b.m1))))
        assertEquals(setOf(b.b1, b.b3), bindingsOf(scope(milestones = listOf(b.m1, b.m3, b.m3))))
        assertEquals(
            setOf(b.bProgram, b.bProject, b.b2),
            bindingsOf(scope(programs = listOf(b.program), projects = listOf(b.pj), milestones = listOf(b.m2))),
            "named lists are ORed",
        )
        assertEquals(emptySet(), bindingsOf(scope(programs = listOf(999_999u), projects = listOf(999_999u), milestones = listOf(999_999u))))
        // A node of a project that is not named is not matched through its project: milestones are named by their own ids.
        assertEquals(setOf(b.bProject), bindingsOf(scope(projects = listOf(b.pj, b.pj2))))
    }

    @Test
    fun `a named EMPTY list names nothing - never everything - and renders valid SQL`() = testApplication {
        val b = world("dsn2")
        fun scope(programs: List<UInt>? = null, projects: List<UInt>? = null, milestones: List<UInt>? = null) =
            DeviationScope(connectionId = b.c, programIds = programs, projectIds = projects, milestoneIds = milestones)

        assertEquals(emptySet(), bindingsOf(scope(programs = emptyList())))
        assertEquals(emptySet(), bindingsOf(scope(projects = emptyList())))
        assertEquals(emptySet(), bindingsOf(scope(milestones = emptyList())))
        assertEquals(emptySet(), bindingsOf(scope(emptyList(), emptyList(), emptyList())))
        // An empty list beside a non-empty one adds nothing and widens nothing.
        assertEquals(setOf(b.b1), bindingsOf(scope(projects = emptyList(), milestones = listOf(b.m1))))
        assertEquals(setOf(b.bProject), bindingsOf(scope(projects = listOf(b.pj), milestones = emptyList())))
        // `levels` is a set filter with the same rule: an empty set keeps no level.
        assertEquals(emptySet(), bindingsOf(DeviationScope(connectionId = b.c, levels = emptySet())))
    }

    @Test
    fun `levels keep every binding of the named levels, and compose with the named nodes as a filter`() = testApplication {
        val b = world("dsn3")
        val projectsAndMilestones = setOf(JiraLevel.PROJECT, JiraLevel.MILESTONE)
        assertEquals(
            setOf(b.bProject, b.b1, b.b2, b.b3),
            bindingsOf(DeviationScope(connectionId = b.c, levels = projectsAndMilestones)),
            "the timeline fold's whole-plan scope: never a program",
        )
        assertEquals(setOf(b.bProgram), bindingsOf(DeviationScope(connectionId = b.c, levels = setOf(JiraLevel.PROGRAM))))
        assertEquals(
            emptySet(),
            bindingsOf(DeviationScope(connectionId = b.c, projectIds = listOf(b.pj), levels = setOf(JiraLevel.MILESTONE))),
            "a project binding named by id is excluded by the level filter",
        )
        assertEquals(
            setOf(b.bProject, b.b2),
            bindingsOf(
                DeviationScope(
                    connectionId = b.c, projectIds = listOf(b.pj), milestoneIds = listOf(b.m2), levels = projectsAndMilestones,
                ),
            ),
        )
    }

    @Test
    fun `a dead node stays hidden when it is named, and another connection's bindings are matched only without a connection scope`() =
        testApplication {
            val b = world("dsn4")
            val other = ledger.track(b.w.admin.client.dvConnection())
            val m4 = TestPlan.milestone(b.pj, b.w.requireTeams().teamId)
            val ofOther = deviatingBinding(other, JiraLevel.MILESTONE, m4)
            val named = DeviationScope(connectionId = b.c, milestoneIds = listOf(b.m1, b.m2, m4))
            assertEquals(setOf(b.b1, b.b2), bindingsOf(named))
            assertEquals(setOf(b.b1, b.b2, ofOther), bindingsOf(DeviationScope(milestoneIds = listOf(b.m1, b.m2, m4))))

            jbSql("UPDATE milestones SET marked_as_deleted = TRUE WHERE id = ?", b.m1.toInt())
            assertEquals(setOf(b.b2), bindingsOf(named), "its binding stays an active row but the node is dead")
            jbSql("UPDATE projects SET marked_as_deleted = TRUE WHERE id = ?", b.pj.toInt())
            assertEquals(emptySet(), bindingsOf(DeviationScope(connectionId = b.c, projectIds = listOf(b.pj), milestoneIds = listOf(b.m2))))
        }

    @Test
    fun `a narrowed computation raises exactly what the full one does, including a parent bound outside the scope`() = testApplication {
        val b = world("dsn5")
        // m3's Jira parent is the issue bound to project pj, but m3 sits under pj2: PARENT_MISMATCH, which needs pj's binding
        // although only m3 is in the scope.
        val projectIssue = jbScalar("SELECT jira_issue_id FROM jira_bindings WHERE id = ?", b.bProject.toInt()) { it.getString(1) }
        val projectKey = jbScalar("SELECT jira_issue_key FROM jira_bindings WHERE id = ?", b.bProject.toInt()) { it.getString(1) }
        val reparent = "UPDATE jira_observations SET parent_issue_id = ?, parent_issue_key = ? WHERE binding_id = ?"
        jbSql(reparent, projectIssue, projectKey, b.b3.toInt())

        val service = application.attributes[DeviationViewServiceKey]
        val asOf = LocalDate.now(ZoneOffset.UTC)
        val (narrow, full) = suspendTransaction(sharedDatabaseForTests()) {
            val calendar = loadWorkingCalendar()
            val one = service.computeInTransaction(DeviationScope(connectionId = b.c, milestoneIds = listOf(b.m3)), null, calendar, asOf)
            val all = service.computeInTransaction(DeviationScope(connectionId = b.c), null, calendar, asOf)
            one.candidates.single().all to all.candidates.single { it.bindingId == b.b3 }.all
        }
        assertEquals(full, narrow)
        assertTrue(DeviationKind.PARENT_MISMATCH in narrow.map { it.kind }, "the parent binding outside the scope was looked up")
    }

    @Test
    fun `the referenced-connections scope resolves only the connections its bindings use, and none for no bindings`() = testApplication {
        val b = world("dsn6")
        val idle = ledger.track(b.w.admin.client.dvConnection())
        val service = application.attributes[DeviationViewServiceKey]
        val asOf = LocalDate.now(ZoneOffset.UTC)
        suspend fun connectionsOf(scope: DeviationScope) = suspendTransaction(sharedDatabaseForTests()) {
            service.computeInTransaction(scope, null, loadWorkingCalendar(), asOf).connections.map { it.id }
        }
        assertTrue(idle in connectionsOf(DeviationScope(milestoneIds = listOf(b.m1))), "the view's scope lists every active connection")
        assertEquals(
            listOf(b.c),
            connectionsOf(DeviationScope(milestoneIds = listOf(b.m1), referencedConnectionsOnly = true)),
            "the fold's scope resolves only the bound one",
        )
        assertEquals(emptyList(), connectionsOf(DeviationScope(milestoneIds = emptyList(), referencedConnectionsOnly = true)))
    }
}
