package ch.nokillswit

import ch.nokillswit.jira.DeviationViewServiceKey
import ch.nokillswit.jira.JiraFlagSource
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.planning.ExternalFlagRequest
import ch.nokillswit.planning.ExternalFlags
import ch.nokillswit.planning.FLAG_ORDER
import ch.nokillswit.planning.FlagKind
import ch.nokillswit.planning.FlagSeverity
import ch.nokillswit.planning.JiraSite
import ch.nokillswit.planning.NodeExternal
import ch.nokillswit.planning.PlanFlag
import ch.nokillswit.planning.SNAPSHOT
import ch.nokillswit.planning.loadWorkingCalendar
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.junit.After
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Jira side of the timeline views' flag seam, asked directly inside a read-only snapshot like the views do: what a binding's
 * link and flags are for each deviation, the project roll-up, and the four things that raise NOTHING (an acknowledgement that is
 * current, a disabled connection, `ESTIMATE_NOT_COMPARABLE`, a clean binding). The views through HTTP are `TimelineJiraFlagsTest`.
 */
class JiraFlagSourceTest {
    private val ledger = ConnectionLedger()

    @After
    fun dropConnections() = ledger.drop()

    private class Fx(val w: PlanWorld, val c: UInt) {
        val team = w.requireTeams().teamId

        /** A milestone of [projectId] (scheduled when [start] is given) bound on [connection] with the observation [obs] of its name. */
        suspend fun milestone(
            start: String? = null,
            end: String? = null,
            connection: UInt = c,
            projectId: UInt = w.projectId,
            obs: (String) -> DvObs? = { DvObs(it, 1) },
        ): Pair<UInt, UInt> {
            val name = planName("ms")
            val id = TestPlan.milestone(projectId, team, name)
            if (start != null) TestPlan.schedule(id, start, end)
            val (issueId, key) = nextIssue()
            return id to dvBind(connection, JiraLevel.MILESTONE, id, issueId, key, obs(name))
        }

        /** The kinds and severities of [flags] as pairs, in order. */
        fun shape(flags: List<PlanFlag>) = flags.map { (it.deviation?.kind ?: it.kind) to it.severity }

        /** Acknowledges [binding] exactly as the item stands now. */
        suspend fun acknowledge(binding: UInt) {
            w.admin.client.ack(binding, w.admin.client.ackItem(c, binding).fingerprint).acknowledgement()
        }
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fx {
        usePostgresTestcontainer()
        val w = planWorld(prefix, teams = true)
        return Fx(w, ledger.track(w.admin.client.dvConnection()))
    }

    /** The source asked inside a read-only snapshot, the way the views ask it. */
    private suspend fun ApplicationTestBuilder.ask(projects: Collection<UInt>?, milestones: Collection<UInt>?): ExternalFlags {
        val source = JiraFlagSource(application.attributes[DeviationViewServiceKey])
        return suspendTransaction(sharedDatabaseForTests(), SNAPSHOT, readOnly = true) {
            source.flagsInTransaction(ExternalFlagRequest(projects, milestones, loadWorkingCalendar()))
        }
    }

    @Test
    fun `each deviation becomes a JIRA_DEVIATION flag at its severity carrying the deviation, in flag order`() = testApplication {
        val f = fixture("jfs1")
        // The plan ends LATER than Jira (WARNING), the name differs (INFO), and a second milestone has the wrong hierarchy level (WARNING).
        val (late, lateBinding) = f.milestone("2044-02-07", "2044-02-18") {
            DvObs("Other name", 1, start = "2044-02-07", end = "2044-02-11")
        }
        val (level, levelBinding) = f.milestone { DvObs(it, 3) }
        val answer = ask(emptyList(), listOf(late, level))

        val oracle = f.w.admin.client.dvView("connectionId=${f.c}&all=true").byBinding()
        for ((milestone, binding) in listOf(late to lateBinding, level to levelBinding)) {
            val flags = answer.milestone(milestone).flags
            val carried = flags.map { checkNotNull(it.deviation) }
            assertEquals(oracle.getValue(binding).deviations, carried, "the flags carry the view's deviations")
            assertTrue(flags.all { it.kind == FlagKind.JIRA_DEVIATION && it.days == null && it.teamId == null && it.count == null })
            assertEquals(flags.sortedWith(FLAG_ORDER), flags)
        }
        assertEquals(
            listOf(DeviationKind.END_DIFFERS to FlagSeverity.WARNING, DeviationKind.RENAMED to FlagSeverity.INFO),
            f.shape(answer.milestone(late).flags),
        )
        assertEquals(listOf(DeviationKind.LEVEL_MISMATCH to FlagSeverity.WARNING), f.shape(answer.milestone(level).flags))
        val link = checkNotNull(answer.milestone(late).jira)
        assertEquals(listOf(lateBinding, f.c, "2044-02-07", "2044-02-11"), listOf(link.bindingId, link.connectionId, link.start, link.end))
    }

    @Test
    fun `an unbound, clean, unobserved or estimate-noise binding raises nothing, and the link says what is known`() = testApplication {
        val f = fixture("jfs2")
        val unbound = TestPlan.milestone(f.w.projectId, f.team)
        val (clean, _) = f.milestone("2044-02-07", "2044-02-11") { DvObs(it, 1, start = "2044-02-07", end = "2044-02-11") }
        val (never, neverBinding) = f.milestone(obs = { null })
        // Hours against a points mapping: the kernel says "a figure exists and cannot be compared" - INFO in the view, never a flag.
        val (noise, noiseBinding) = f.milestone { DvObs(it, 1, estimate = "8", unit = "HOURS") }
        val answer = ask(emptyList(), listOf(unbound, clean, never, noise))

        assertEquals(NodeExternal.NONE, answer.milestone(unbound))
        assertEquals(emptyList(), answer.milestone(clean).flags)
        assertEquals(listOf("2044-02-07", "2044-02-11"), answer.milestone(clean).jira.let { listOf(it?.start, it?.end) })
        assertEquals(emptyList(), answer.milestone(never).flags)
        assertEquals(neverBinding, answer.milestone(never).jira?.bindingId)
        assertNull(answer.milestone(never).jira?.start, "never observed: no dates")
        val item = f.w.admin.client.ackItem(f.c, noiseBinding)
        assertEquals(listOf(DeviationKind.ESTIMATE_NOT_COMPARABLE), item.deviations.map { it.kind }, "the kernel did raise it")
        assertEquals(emptyList(), answer.milestone(noise).flags, "and the timeline does not")
        assertEquals(noiseBinding, answer.milestone(noise).jira?.bindingId, "the item still has its bar")
    }

    @Test
    fun `a gone item raises GONE alone and its dates are null`() = testApplication {
        val f = fixture("jfs3")
        val (gone, _) = f.milestone("2044-02-07", "2044-02-11") {
            DvObs(it, 1, start = "2044-02-07", end = "2044-02-11", gone = true, goneReason = "OUT_OF_SCOPE")
        }
        val answer = ask(emptyList(), listOf(gone))
        val external = answer.milestone(gone)
        assertEquals(listOf(DeviationKind.GONE to FlagSeverity.WARNING), f.shape(external.flags))
        assertEquals("OUT_OF_SCOPE", external.flags.single().deviation?.detail?.jira)
        assertEquals(listOf<String?>(null, null), listOf(external.jira?.start, external.jira?.end), "stale dates are not drawn")
    }

    @Test
    fun `a current acknowledgement raises nothing, a stale one raises again, and the link stays either way`() = testApplication {
        val f = fixture("jfs4")
        val (m, binding) = f.milestone { DvObs("Not the name", 1) }
        assertEquals(1, ask(emptyList(), listOf(m)).milestone(m).flags.size)

        f.acknowledge(binding)
        val acknowledged = ask(emptyList(), listOf(m)).milestone(m)
        assertEquals(emptyList(), acknowledged.flags)
        assertEquals(binding, acknowledged.jira?.bindingId, "an acknowledgement silences the flags, not the bar")

        jbSql("UPDATE jira_observations SET summary = 'changed since' WHERE binding_id = ?", binding.toInt())
        val stale = ask(emptyList(), listOf(m)).milestone(m)
        assertEquals(listOf(DeviationKind.RENAMED to FlagSeverity.INFO), f.shape(stale.flags), "acknowledged, then changed: open again")
        assertEquals(false, f.w.admin.client.ackItem(f.c, binding).acknowledgement?.current)
    }

    @Test
    fun `a disabled connection raises nothing, answers no link and no site, and its siblings are unaffected`() = testApplication {
        val f = fixture("jfs5")
        val disabled = ledger.track(f.w.admin.client.dvConnection(enabled = false))
        val (live, _) = f.milestone { DvObs("Not the name", 1) }
        val (off, _) = f.milestone(connection = disabled) { DvObs("Not the name", 1, start = "2044-02-07", end = "2044-02-11") }
        val answer = ask(emptyList(), listOf(live, off))

        assertEquals(NodeExternal.NONE, answer.milestone(off))
        assertEquals(1, answer.milestone(live).flags.size)
        assertEquals(listOf(f.c), answer.sites.map { it.connectionId }, "the disabled connection is not a site")
        val siteUrl = f.w.admin.client.dvView().connections.single { it.id == f.c }.siteUrl
        assertEquals(listOf(JiraSite(f.c, siteUrl)), answer.sites)

        // The same rule when the connection is switched off AFTER the binding raised a flag.
        jbSql("UPDATE jira_connections SET enabled = FALSE WHERE id = ?", f.c.toInt())
        val after = ask(emptyList(), listOf(live, off))
        assertEquals(emptyList(), after.milestones.keys.toList())
        assertEquals(emptyList(), after.sites)
    }

    @Test
    fun `a project rolls its milestones up into ONE flag - the count of milestones that raised, the worst severity`() = testApplication {
        val f = fixture("jfs6")
        val (warn, warnBinding) = f.milestone("2044-02-07", "2044-02-18") { DvObs("x$it", 1, start = "2044-02-07", end = "2044-02-11") }
        val (info, infoBinding) = f.milestone { DvObs("Not the name", 1) }
        val (clean, _) = f.milestone { DvObs(it, 1) }
        val (acked, ackedBinding) = f.milestone { DvObs("Not the name either", 1) }
        f.acknowledge(ackedBinding)
        val projectBinding = deviatingBinding(f.c, JiraLevel.PROJECT, f.w.projectId)
        val ids = listOf(warn, info, clean, acked)

        val rolled = ask(listOf(f.w.projectId), ids).project(f.w.projectId)
        assertEquals(
            listOf(FlagKind.JIRA_MILESTONES, FlagKind.JIRA_DEVIATION),
            rolled.flags.map { it.kind },
            "WARNING first: the roll-up (worst milestone severity) before the project's own INFO",
        )
        val rollUp = rolled.flags.single { it.kind == FlagKind.JIRA_MILESTONES }
        assertEquals(2, rollUp.count, "two milestones raised; the clean and the acknowledged one do not count")
        assertEquals(FlagSeverity.WARNING, rollUp.severity)
        assertNull(rollUp.deviation)
        assertEquals(projectBinding, rolled.jira?.bindingId)

        // Acknowledge the WARNING milestone: the worst severity of the roll-up drops to INFO and the count to 1.
        f.acknowledge(warnBinding)
        val lower = ask(listOf(f.w.projectId), ids).project(f.w.projectId).flags.single { it.kind == FlagKind.JIRA_MILESTONES }
        assertEquals(1 to FlagSeverity.INFO, lower.count to lower.severity)
        f.acknowledge(infoBinding)
        assertEquals(
            listOf(FlagKind.JIRA_DEVIATION),
            ask(listOf(f.w.projectId), ids).project(f.w.projectId).flags.map { it.kind },
            "no open milestone: no roll-up",
        )
    }

    @Test
    fun `a roll-up exists only for a project the request names, and an unbound project still gets one`() = testApplication {
        val f = fixture("jfs7")
        val (m, _) = f.milestone { DvObs("Not the name", 1) }
        val teamView = ask(emptyList(), listOf(m))
        assertEquals(emptyMap(), teamView.projects, "the team view names no project: the partial count would be wrong")
        assertEquals(1, teamView.milestones.size)

        val named = ask(listOf(f.w.projectId), listOf(m)).project(f.w.projectId)
        assertNull(named.jira, "the project is not bound itself")
        assertEquals(listOf(FlagKind.JIRA_MILESTONES), named.flags.map { it.kind })
        assertEquals(1, named.flags.single().count)

        val whole = ask(null, null)
        assertEquals(listOf(FlagKind.JIRA_MILESTONES), whole.project(f.w.projectId).flags.map { it.kind })
        assertEquals(1, whole.milestone(m).flags.size)
    }

    @Test
    fun `an empty request reads nothing, and a request naming only one kind is refused`() = testApplication {
        val f = fixture("jfs8")
        f.milestone { DvObs("Not the name", 1) }
        val none = ask(emptyList(), emptyList())
        assertEquals(emptyMap(), none.projects + none.milestones)
        assertEquals(emptyList(), none.sites)
        assertFailsWith<IllegalArgumentException> { ask(null, emptyList()) }
        assertFailsWith<IllegalArgumentException> { ask(emptyList(), null) }
        // Severity vocabulary: a flag's severity is the deviation's, name for name.
        assertEquals(FlagSeverity.entries.map { it.name }, DeviationSeverity.entries.map { it.name })
    }
}
