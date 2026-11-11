package ch.nokillswit

import ch.nokillswit.jira.DeviationScope
import ch.nokillswit.jira.DeviationViewServiceKey
import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.jira.fingerprintOf
import ch.nokillswit.planning.DeviationKind
import ch.nokillswit.planning.loadWorkingCalendar
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.junit.After
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * What 1.3's acknowledgement does to `GET /views/deviations`: the default lists OPEN items, `acknowledged=`, `all`, the chips' implied
 * `all`, the totals (open only, plus `acknowledged`), `can.acknowledge` per caller and the fingerprint. The write side is
 * `JiraAcknowledgeTest`; the view's other behavior `DeviationViewTest` and `DeviationViewScopeTest`.
 */
class DeviationViewAckTest {
    private val ledger = ConnectionLedger()

    @After
    fun dropConnections() = ledger.drop()

    private class Fixture(val w: PlanWorld, val c: UInt) {
        val team = w.requireTeams().teamId

        suspend fun view(query: String = "") = w.admin.client.dvView("connectionId=$c" + if (query.isEmpty()) "" else "&$query")

        fun ids(view: ch.nokillswit.jira.DeviationView) = view.items.map { it.bindingId }.toSet()
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        usePostgresTestcontainer()
        val w = planWorld(prefix, teams = true)
        return Fixture(w, ledger.track(w.admin.client.dvConnection()))
    }

    /** The totals as (warnings, infos, bindings, gone, acknowledged). */
    private fun ch.nokillswit.jira.DeviationTotals.asList() = listOf(warnings, infos, bindings, gone, acknowledged)

    /** Four milestones' bindings: open, acknowledged, acknowledged-then-changed (stale) and clean. */
    private class Four(val open: UInt, val acked: UInt, val stale: UInt, val clean: UInt)

    private suspend fun Fixture.four(): Four {
        suspend fun milestone(name: String = planName("ms")) = TestPlan.milestone(w.projectId, team, name) to name
        val (a, _) = milestone()
        val (b, _) = milestone()
        val (c1, _) = milestone()
        val (d, dName) = milestone()
        val open = deviatingBinding(c, JiraLevel.MILESTONE, a)
        val acked = deviatingBinding(c, JiraLevel.MILESTONE, b)
        val stale = deviatingBinding(c, JiraLevel.MILESTONE, c1)
        val clean = dvBind(c, JiraLevel.MILESTONE, d, "71004", "ACK-71004", DvObs(dName, 1))
        for (id in listOf(acked, stale)) w.admin.client.ack(id, w.admin.client.ackItem(c, id).fingerprint).acknowledgement()
        jbSql("UPDATE jira_observations SET summary = 'changed since' WHERE binding_id = ?", stale.toInt())
        return Four(open, acked, stale, clean)
    }

    @Test
    fun `the default lists the open items, acknowledged lists the current ones, all lists everything, and the totals count open ones`() =
        testApplication {
            val f = fixture("dva1")
            val four = f.four()
            val default = f.view()
            assertEquals(setOf(four.open, four.stale), f.ids(default), "open: deviating and not currently acknowledged")
            assertEquals(listOf(0, 2, 2, 0, 1), default.totals.asList())

            val current = f.view("acknowledged=true")
            assertEquals(setOf(four.acked), f.ids(current))
            assertEquals(listOf(0, 2, 1, 0, 1), current.totals.asList(), "the open counts share the acknowledged count's basis")

            assertEquals(setOf(four.open, four.stale), f.ids(f.view("acknowledged=false")))
            assertEquals(setOf(four.open, four.stale, four.clean), f.ids(f.view("acknowledged=false&all=true")))
            val all = f.view("all=true")
            assertEquals(four.run { setOf(open, acked, stale, clean) }, f.ids(all))
            assertEquals(listOf(0, 2, 4, 0, 1), all.totals.asList(), "the acknowledged one is not open")
            assertEquals(setOf(four.acked), f.ids(f.view("all=true&acknowledged=true")))
            assertEquals(setOf(four.open, four.stale), f.ids(f.view("kind=RENAMED")), "filters compose with the open default")
            assertTrue(f.ids(f.view("kind=END_DIFFERS")).isEmpty())
        }

    @Test
    fun `a project chip lists everything with its acknowledgement state and counts open items only, all=false hides them`() =
        testApplication {
            val f = fixture("dva2")
            val four = f.four()
            val chip = f.w.admin.client.dvView("connectionId=${f.c}&projectId=${f.w.projectId}")
            assertEquals(four.run { setOf(open, acked, stale, clean) }, chip.items.map { it.bindingId }.toSet(), "the chip implies all")
            val byBinding = chip.byBinding()
            assertEquals(true, byBinding.getValue(four.acked).acknowledgement?.current)
            assertEquals(false, byBinding.getValue(four.stale).acknowledgement?.current)
            assertNull(byBinding.getValue(four.open).acknowledgement)
            assertEquals(2, chip.totals.infos, "the open ones: the acknowledged item's deviation does not count")
            val hidden = f.w.admin.client.dvView("connectionId=${f.c}&projectId=${f.w.projectId}&all=false")
            assertEquals(setOf(four.open, four.stale), hidden.items.map { it.bindingId }.toSet())
        }

    @Test
    fun `a partly acknowledged binding is listed under every status with each line's state, counts its open lines and ranks by them`() =
        testApplication {
            val f = fixture("dva9")
            val admin = f.w.admin.client
            val a = twoLineBinding(f.c, f.w.projectId, f.team, planName("aaa"))
            val b = twoLineBinding(f.c, f.w.projectId, f.team, planName("zzz"))
            val full = twoLineBinding(f.c, f.w.projectId, f.team, planName("mmm"))
            val end = DeviationKind.END_DIFFERS
            val renamed = DeviationKind.RENAMED
            // A: the WARNING acknowledged (the INFO open). B: the INFO acknowledged (the WARNING open). FULL: both.
            admin.ack(a.binding, admin.ackItem(f.c, a.binding).fingerprint, end).acknowledgement()
            admin.ack(b.binding, admin.ackItem(f.c, b.binding).fingerprint, renamed).acknowledgement()
            admin.ack(full.binding, admin.ackItem(f.c, full.binding).fingerprint).acknowledgement()

            val open = f.view()
            assertEquals(listOf(b.binding, a.binding), open.items.map { it.bindingId }, "an open WARNING first, the name only after that")
            val byBinding = open.byBinding()
            assertEquals(mapOf(end to true, renamed to null), byBinding.getValue(a.binding).lineStates(), "every line, whatever the state")
            assertEquals(mapOf(end to null, renamed to true), byBinding.getValue(b.binding).lineStates())
            assertEquals(listOf(1, 1, 2, 0, 3), open.totals.asList(), "the open LINES: B's WARNING, A's INFO")
            for (item in listOf(a, b).map { byBinding.getValue(it.binding) }) {
                assertEquals(false, assertNotNull(item.acknowledgement, "the summary").current, "not every listed line is current")
            }
            val summary = assertNotNull(byBinding.getValue(a.binding).acknowledgement)
            assertEquals(byBinding.getValue(a.binding).deviations.first().acknowledgement?.at, summary.at)

            assertEquals(setOf(a.binding, b.binding, full.binding), f.ids(f.view("acknowledged=true")), "a current line is enough")
            assertEquals(setOf(a.binding, b.binding), f.ids(f.view("acknowledged=false")), "the open ones")
            assertEquals(setOf(a.binding, b.binding, full.binding), f.ids(f.view("all=true")))

            // A chip matches the lines of the selected Status (D11): the OPEN lines by default, the CURRENT ones under acknowledged=true.
            assertEquals(setOf(b.binding), f.ids(f.view("kind=END_DIFFERS")), "Open + End differs: A's End line is acknowledged")
            assertEquals(setOf(a.binding), f.ids(f.view("kind=RENAMED")))
            assertEquals(setOf(b.binding), f.ids(f.view("severity=WARNING&acknowledged=false")))
            assertEquals(setOf(a.binding, full.binding), f.ids(f.view("kind=END_DIFFERS&acknowledged=true")), "its acknowledged End lines")
            assertEquals(setOf(b.binding, full.binding), f.ids(f.view("severity=INFO&acknowledged=true")))
            val anyStatus = f.ids(f.view("kind=END_DIFFERS&all=true"))
            assertEquals(setOf(a.binding, b.binding, full.binding), anyStatus, "no status: any listed line")
            val chip = f.view("kind=END_DIFFERS")
            assertEquals(2, chip.items.single().deviations.size, "the listed binding still shows every line")
            assertEquals(listOf(1, 1), chip.totals.asList().take(2), "totals stay the open lines of the scope")
        }

    @Test
    fun `a stamp on the hidden estimate noise alone does not make a binding acknowledged`() = testApplication {
        val f = fixture("dva10")
        val name = planName("noisy-ack")
        val id = TestPlan.milestone(f.w.projectId, f.team, name)
        // RENAMED (INFO, listed) plus ESTIMATE_NOT_COMPARABLE (DAYS read under a POINTS mapping: hidden unless asked for).
        val binding = dvBind(f.c, JiraLevel.MILESTONE, id, "71010", "ACK-71010", DvObs("Other name", 1, estimate = "5.00", unit = "DAYS"))
        val admin = f.w.admin.client
        admin.ack(binding, admin.ackItem(f.c, binding).fingerprint).acknowledgement()
        assertTrue(f.view().items.isEmpty(), "both lines acknowledged: not open")
        assertEquals(setOf(binding), f.ids(f.view("acknowledged=true")))

        // Jira renames again: the listed line is open, the hidden estimate stamp is still current.
        jbSql("UPDATE jira_observations SET summary = 'Yet another name' WHERE binding_id = ?", binding.toInt())
        val open = f.view()
        assertEquals(setOf(binding), f.ids(open), "open")
        assertEquals(0, open.totals.acknowledged, "no listed line is acknowledged")
        assertTrue(f.ids(f.view("acknowledged=true")).isEmpty(), "so it is not in the Acknowledged list as well")
        assertEquals(setOf(binding), f.ids(f.view("acknowledged=false")))
        assertEquals(setOf(binding), f.ids(f.view("all=true&acknowledged=true")), "the noise line is listed here, and acknowledged")
    }

    @Test
    fun `acknowledged is a strict boolean - a repeated or malformed value is 400`() = testApplication {
        val f = fixture("dva3")
        val malformed = listOf("acknowledged=yes", "acknowledged=1", "acknowledged=TRUE")
        for (query in malformed + listOf("acknowledged=true&acknowledged=false", "acknowledged=true&acknowledged=true")) {
            assertEquals(HttpStatusCode.BadRequest, f.w.admin.client.get("$DV_VIEW?$query").status, query)
        }
        assertEquals(HttpStatusCode.OK, f.w.admin.client.get("$DV_VIEW?acknowledged=false").status)
    }

    @Test
    fun `an open gone issue counts in the totals and an acknowledged one does not`() = testApplication {
        val f = fixture("dva4")
        val id = TestPlan.milestone(f.w.projectId, f.team, planName("gone"))
        val gone = DvObs("stale", 0, gone = true, goneReason = "OUT_OF_SCOPE")
        val binding = dvBind(f.c, JiraLevel.MILESTONE, id, "71005", "ACK-71005", gone)
        assertEquals(1, f.view().totals.gone)
        f.w.admin.client.ack(binding, f.w.admin.client.ackItem(f.c, binding).fingerprint).acknowledgement()
        val after = f.view()
        assertEquals(listOf(0, 0, 0), listOf(after.totals.gone, after.totals.bindings, after.items.size))
        assertEquals(1, after.totals.acknowledged)
        assertTrue(f.view("acknowledged=true").items.single().jira.gone)
    }

    @Test
    fun `can acknowledge follows the acknowledge guard for every caller and level, a team manager on the milestone`() = testApplication {
        val f = fixture("dva5")
        val w = f.w
        val milestone = TestPlan.milestone(w.projectId, f.team)
        val ms = deviatingBinding(f.c, JiraLevel.MILESTONE, milestone)
        val project = deviatingBinding(f.c, JiraLevel.PROJECT, w.projectId)
        val program = deviatingBinding(f.c, JiraLevel.PROGRAM, w.programId)
        val expected = mapOf(
            "admin" to (w.admin to listOf(true, true, true)),
            "stream owner" to (w.streamOwner to listOf(true, true, true)),
            "program owner" to (w.programOwner to listOf(true, true, true)),
            "project owner" to (w.projectOwner to listOf(true, true, false)),
            "stranger" to (w.stranger to listOf(false, false, false)),
            "personless" to (w.personless to listOf(false, false, false)),
            "editor" to (w.editor to listOf(false, false, false)),
            "team manager" to (w.requireTeams().manager to listOf(true, false, false)),
            "other team's manager" to (w.requireTeams().otherManager to listOf(false, false, false)),
        )
        for ((who, pair) in expected) {
            val items = pair.first.client.dvView("connectionId=${f.c}").byBinding()
            val got = listOf(ms, project, program).map { assertNotNull(items[it]).can.acknowledge }
            assertEquals(pair.second, got, "$who: milestone, project, program")
        }
    }

    @Test
    fun `the fingerprint is stable across reads and filters, and counts the estimate noise the default hides`() = testApplication {
        val f = fixture("dva6")
        val name = planName("noisy")
        val id = TestPlan.milestone(f.w.projectId, f.team, name)
        // Renamed (INFO) plus an estimate read under DAYS while the mapping names POINTS: ESTIMATE_NOT_COMPARABLE (listed only on request).
        val binding = dvBind(f.c, JiraLevel.MILESTONE, id, "71006", "ACK-71006", DvObs("Other name", 1, estimate = "5.00", unit = "DAYS"))
        val first = f.w.admin.client.ackItem(f.c, binding)
        assertTrue(first.deviations.any { it.kind == DeviationKind.ESTIMATE_NOT_COMPARABLE }, "all=true lists the noise")
        val second = f.w.admin.client.ackItem(f.c, binding)
        assertEquals(first.fingerprint, second.fingerprint, "two reads of an unchanged binding")
        val hidden = f.view().items.single()
        assertFalse(hidden.deviations.any { it.kind == DeviationKind.ESTIMATE_NOT_COMPARABLE }, "the default list hides it")
        assertEquals(first.fingerprint, hidden.fingerprint, "the fingerprint does not depend on what is listed")
        assertEquals(first.fingerprint, f.view("kind=RENAMED").items.single().fingerprint)
        assertEquals(first.fingerprint, f.view("kind=ESTIMATE_NOT_COMPARABLE").items.single().fingerprint)
        assertEquals(first.fingerprint, f.w.stranger.client.ackItem(f.c, binding).fingerprint, "not a function of the caller")
    }

    @Test
    fun `a binding whose only deviation is the estimate noise can be acknowledged with its fingerprint - the full list is what counts`() =
        testApplication {
            val f = fixture("dva7")
            val name = planName("noise-only")
            val id = TestPlan.milestone(f.w.projectId, f.team, name)
            val binding = dvBind(f.c, JiraLevel.MILESTONE, id, "71007", "ACK-71007", DvObs(name, 1, estimate = "5.00", unit = "DAYS"))
            val item = f.w.admin.client.ackItem(f.c, binding)
            assertEquals(listOf(DeviationKind.ESTIMATE_NOT_COMPARABLE), item.deviations.map { it.kind })
            assertTrue(f.view().items.isEmpty(), "never open: the default does not list the noise")
            f.w.admin.client.ack(binding, item.fingerprint).acknowledgement()
            assertTrue(f.ids(f.view("acknowledged=true")).isEmpty(), "the hidden noise is no listed line: not 'acknowledged' by default")
            assertEquals(setOf(binding), f.ids(f.view("all=true&acknowledged=true")), "it surfaces where the noise is listed")
        }

    @Test
    fun `a milestone whose Jira parent is bound elsewhere is acknowledged with the view's fingerprint`() =
        testApplication {
            val f = fixture("dva8")
            val w = f.w
            val other = secondProject(w, "dva8sp")
            val otherName = TestPlan.scalar("SELECT name FROM projects WHERE id = ${other.projectId}") { it.getString(1) }
            // Jira parent 72001 is bound to the OTHER project, not to the milestone's plan parent: PARENT_MISMATCH.
            dvBind(f.c, JiraLevel.PROJECT, other.projectId, "72001", "ACK-72001", DvObs(otherName, 2))
            val name = planName("child")
            val milestone = TestPlan.milestone(w.projectId, f.team, name)
            val child = DvObs(name, 1, parentId = "72001", parentKey = "ACK-72001")
            val binding = dvBind(f.c, JiraLevel.MILESTONE, milestone, "72002", "ACK-72002", child)
            val item = w.admin.client.ackItem(f.c, binding)
            assertEquals(listOf(DeviationKind.PARENT_MISMATCH), item.deviations.map { it.kind })

            // The scoped computation (one binding, the parent's binding looked up) equals the full computation's list for it.
            val service = application.attributes[DeviationViewServiceKey]
            val asOf = java.time.LocalDate.now(java.time.ZoneOffset.UTC)
            val (scoped, full) = suspendTransaction(sharedDatabaseForTests()) {
                val calendar = loadWorkingCalendar()
                val one = service.computeInTransaction(DeviationScope(connectionId = f.c, bindingId = binding), null, calendar, asOf)
                val all = service.computeInTransaction(DeviationScope(connectionId = f.c), null, calendar, asOf)
                one.candidates.single().all to all.candidates.single { it.bindingId == binding }.all
            }
            assertEquals(full, scoped)
            assertEquals(item.fingerprint, fingerprintOf(scoped))

            assertEquals(binding, w.projectOwner.client.ack(binding, item.fingerprint).acknowledgement().bindingId)
            assertEquals(true, w.admin.client.ackItem(f.c, binding).acknowledgement?.current)
        }
}
