package ch.nokillswit

import ch.nokillswit.jira.JiraLevel
import ch.nokillswit.sync.STALE_DEVIATIONS_PROBLEM
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.junit.After
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `POST` and `DELETE /integrations/jira/bindings/{id}/acknowledge` on a seeded world (no stub): the caller matrix per level, the 404
 * that every caller gets BEFORE the guard, the 403-before-400 order, the stale `409`, the view's reading of a stored acknowledgement,
 * the withdrawal and the audit lines. The held-request cases are in `JiraAcknowledgeRaceTest`, a real run in `JiraAcknowledgeRunTest`,
 * the view's filters in `DeviationViewAckTest`.
 */
class JiraAcknowledgeTest {
    private val ledger = ConnectionLedger()

    @After
    fun dropConnections() = ledger.drop()

    private class Fixture(val w: PlanWorld, val connectionId: UInt, val milestone: UInt) {
        val callers: List<Pair<String, PlanCaller>> = listOf(
            "admin" to w.admin, "stream owner" to w.streamOwner, "program owner" to w.programOwner, "project owner" to w.projectOwner,
            "stranger" to w.stranger, "personless" to w.personless, "editor" to w.editor, "team manager" to w.requireTeams().manager,
            "other manager" to w.requireTeams().otherManager,
        )

        suspend fun fingerprint(binding: UInt) = w.admin.client.ackItem(connectionId, binding).fingerprint
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        usePostgresTestcontainer()
        val w = planWorld(prefix, teams = true)
        return Fixture(w, ledger.track(w.admin.client.dvConnection()), TestPlan.milestone(w.projectId, w.requireTeams().teamId))
    }

    @Test
    fun `the owner chain and ADMIN acknowledge at every level, a team manager on a milestone only, others 403`() = testApplication {
        val f = fixture("ack1")
        val w = f.w
        val cases = listOf(
            Triple(JiraLevel.PROGRAM, w.programId, setOf("admin", "stream owner", "program owner")),
            Triple(JiraLevel.PROJECT, w.projectId, setOf("admin", "stream owner", "program owner", "project owner")),
            Triple(JiraLevel.MILESTONE, f.milestone, setOf("admin", "stream owner", "program owner", "project owner", "team manager")),
        )
        for ((level, node, allowed) in cases) {
            val binding = deviatingBinding(f.connectionId, level, node)
            val fingerprint = f.fingerprint(binding)
            for ((who, caller) in f.callers) {
                val label = "$level $who"
                if (who in allowed) {
                    assertEquals(binding, caller.client.ack(binding, fingerprint).acknowledgement().bindingId, label)
                    assertEquals(HttpStatusCode.NoContent, caller.client.unack(binding).status, label)
                } else {
                    assertEquals(HttpStatusCode.Forbidden, caller.client.ack(binding, fingerprint).status, label)
                    assertEquals(HttpStatusCode.Forbidden, caller.client.unack(binding).status, "$label: DELETE")
                }
                assertNull(w.admin.client.ackItem(f.connectionId, binding).acknowledgement, "$label: nothing is left stored")
            }
        }
    }

    @Test
    fun `a milestone's team manager and an owner withdraw each other's stamps, another team's manager neither`() =
        testApplication {
            val f = fixture("ack11")
            val w = f.w
            val teams = w.requireTeams()
            val binding = deviatingBinding(f.connectionId, JiraLevel.MILESTONE, f.milestone)
            val fingerprint = f.fingerprint(binding)

            w.projectOwner.client.ack(binding, fingerprint).acknowledgement()
            assertEquals(HttpStatusCode.Forbidden, teams.otherManager.client.unack(binding).status, "another team's manager")
            assertNotNull(w.admin.client.ackItem(f.connectionId, binding).acknowledgement, "the refused withdrawal changed nothing")
            assertEquals(HttpStatusCode.NoContent, teams.manager.client.unack(binding).status, "the manager withdraws the owner's stamp")
            assertNull(w.admin.client.ackItem(f.connectionId, binding).acknowledgement)

            val managerName = TestPlan.scalar("SELECT name FROM people WHERE id = ${teams.manager.personId}") { it.getString(1) }
            assertEquals(managerName, teams.manager.client.ack(binding, fingerprint).acknowledgement().acknowledgedBy)
            assertEquals(HttpStatusCode.Forbidden, teams.otherManager.client.ack(binding, fingerprint).status)
            assertEquals(HttpStatusCode.NoContent, w.projectOwner.client.unack(binding).status, "the owner withdraws the manager's stamp")

            // The check is on the milestone's STORED team: once it moves, the old team's manager is out and the new one is in.
            teams.manager.client.ack(binding, fingerprint).acknowledgement()
            jbSql("UPDATE milestones SET team_id = ? WHERE id = ?", teams.otherTeamId.toInt(), f.milestone.toInt())
            assertEquals(HttpStatusCode.Forbidden, teams.manager.client.unack(binding).status, "no longer the milestone's team")
            assertEquals(HttpStatusCode.NoContent, teams.otherManager.client.unack(binding).status, "the new team's manager")
        }

    @Test
    fun `an unknown, unbound or dead-node binding is 404 for EVERY caller, before the guard and before the body`() = testApplication {
        val f = fixture("ack2")
        val w = f.w
        val project = secondProject(w, "ack2sp")
        val deadMilestone = TestPlan.milestone(w.projectId, w.requireTeams().teamId)
        val underDeadProject = TestPlan.milestone(project.projectId, w.requireTeams().teamId)
        val deadNode = deviatingBinding(f.connectionId, JiraLevel.MILESTONE, deadMilestone)
        val deadAncestor = deviatingBinding(f.connectionId, JiraLevel.MILESTONE, underDeadProject)
        val unbound = deviatingBinding(f.connectionId, JiraLevel.PROJECT, w.projectId)
        jbSql("UPDATE milestones SET marked_as_deleted = TRUE WHERE id = ?", deadMilestone.toInt())
        jbSql("UPDATE projects SET marked_as_deleted = TRUE WHERE id = ?", project.projectId.toInt())
        jbSql("UPDATE jira_bindings SET marked_as_deleted = TRUE WHERE id = ?", unbound.toInt())
        val fingerprint = "0".repeat(64)
        for ((who, caller) in f.callers) {
            val dead = listOf("unknown" to 999_999u, "unbound" to unbound, "dead node" to deadNode, "dead ancestor" to deadAncestor)
            for ((what, id) in dead) {
                assertEquals(HttpStatusCode.NotFound, caller.client.ack(id, fingerprint).status, "$who: $what")
                assertEquals(HttpStatusCode.NotFound, caller.client.ackRaw(id, "{ not json").status, "$who: $what, a malformed body")
                assertEquals(HttpStatusCode.NotFound, caller.client.unack(id).status, "$who: $what, DELETE")
            }
        }
    }

    @Test
    fun `a forbidden caller's malformed body stays 403 and an owner's is 400 - the guard comes first`() = testApplication {
        val f = fixture("ack3")
        val w = f.w
        val binding = deviatingBinding(f.connectionId, JiraLevel.PROJECT, w.projectId)
        val upper = "A".repeat(64)
        val bodies = listOf("{ not json", "{}", """{"fingerprint":"abc"}""", """{"fingerprint":"$upper"}""", """{"fingerprint":""}""")
        for (body in bodies) {
            assertEquals(HttpStatusCode.Forbidden, w.stranger.client.ackRaw(binding, body).status, "stranger: $body")
            assertEquals(HttpStatusCode.Forbidden, w.personless.client.ackRaw(binding, body).status, "personless: $body")
            assertEquals(HttpStatusCode.BadRequest, w.projectOwner.client.ackRaw(binding, body).status, "owner: $body")
        }
        val shapes = listOf("0".repeat(63), "0".repeat(65), "g".repeat(64), "A".repeat(64))
        for (shape in shapes) assertEquals(HttpStatusCode.BadRequest, w.admin.client.ack(binding, shape).status, shape)
        assertNull(w.admin.client.ackItem(f.connectionId, binding).acknowledgement)
    }

    @Test
    fun `a fingerprint that is not the binding's now, or a binding with no deviation, is 409 stale-deviations and stores nothing`() =
        testApplication {
            val f = fixture("ack4")
            val w = f.w
            val admin = w.admin.client
            val binding = deviatingBinding(f.connectionId, JiraLevel.MILESTONE, f.milestone)
            val stale = admin.ack(binding, "0".repeat(64))
            assertEquals(HttpStatusCode.Conflict, stale.status)
            assertEquals(STALE_DEVIATIONS_PROBLEM, stale.jbProblem().type)

            val name = planName("clean")
            val clean = TestPlan.milestone(w.projectId, w.requireTeams().teamId, name)
            val cleanBinding = dvBind(f.connectionId, JiraLevel.MILESTONE, clean, "70001", "ACK-70001", DvObs(name, 1))
            val item = admin.ackItem(f.connectionId, cleanBinding)
            assertTrue(item.deviations.isEmpty())
            val none = admin.ack(cleanBinding, item.fingerprint)
            assertEquals(HttpStatusCode.Conflict, none.status, "its own fingerprint, but there is nothing to acknowledge")
            assertEquals(STALE_DEVIATIONS_PROBLEM, none.jbProblem().type)
            for (id in listOf(binding, cleanBinding)) assertNull(admin.ackItem(f.connectionId, id).acknowledgement)
        }

    @Test
    fun `an acknowledgement is read back by the view - who, when, current - and leaves the open list`() = testApplication {
        val f = fixture("ack5")
        val w = f.w
        val admin = w.admin.client
        val binding = deviatingBinding(f.connectionId, JiraLevel.MILESTONE, f.milestone)
        val before = admin.dvView("connectionId=${f.connectionId}")
        assertEquals(listOf(binding), before.items.map { it.bindingId })
        assertEquals(1, before.totals.infos, "RENAMED")
        val fingerprint = before.items.single().fingerprint

        val given = w.streamOwner.client.ack(binding, fingerprint).acknowledgement()
        val ownerName = TestPlan.scalar("SELECT name FROM people WHERE id = ${w.streamOwner.personId}") { it.getString(1) }
        assertEquals(fingerprint, given.fingerprint)
        assertEquals(ownerName, given.acknowledgedBy, "the person's name, never the login's email")
        assertTrue(given.acknowledgedAt > 0)

        val open = admin.dvView("connectionId=${f.connectionId}")
        assertTrue(open.items.isEmpty(), "an acknowledged item leaves the default list")
        assertEquals(listOf(0, 0, 0, 0, 1), with(open.totals) { listOf(warnings, infos, bindings, gone, acknowledged) })
        val acknowledged = admin.dvView("connectionId=${f.connectionId}&acknowledged=true").items.single()
        val stored = assertNotNull(acknowledged.acknowledgement)
        assertEquals(listOf(given.acknowledgedAt, ownerName, true), listOf(stored.at, stored.by, stored.current))
        assertEquals(fingerprint, acknowledged.fingerprint, "acknowledging changes nothing about the fingerprint")
        assertEquals(listOf(binding), admin.dvView("connectionId=${f.connectionId}&all=true").items.map { it.bindingId })

        // An ADMIN has no person: the login's display name (the seed's), still not its email.
        assertEquals("Test", admin.ack(binding, fingerprint).acknowledgement().acknowledgedBy)
        jbSql("UPDATE users SET name = 'Display Owner' WHERE id = ?", w.streamOwner.userId.toInt())
        w.streamOwner.client.ack(binding, fingerprint).acknowledgement()
        TestPeople.softDelete(w.streamOwner.personId!!)
        assertEquals("Display Owner", admin.ackItem(f.connectionId, binding).acknowledgement?.by, "no active person: the display name")
        TestUsers.softDelete(w.streamOwner.userId)
        val orphaned = assertNotNull(admin.ackItem(f.connectionId, binding).acknowledgement, "a deleted login keeps its acknowledgement")
        assertNull(orphaned.by)
    }

    @Test
    fun `a change that alters a deviation reopens the item with the old stamp, one that alters none does not`() =
        testApplication {
            val f = fixture("ack6")
            val w = f.w
            val admin = w.admin.client
            val name = planName("dated")
            val id = TestPlan.milestone(w.projectId, w.requireTeams().teamId, name)
            TestPlan.schedule(id, "2044-02-01", "2044-02-09")
            val jira = DvObs(name, 1, start = "2044-02-01", end = "2044-02-04")
            val binding = dvBind(f.connectionId, JiraLevel.MILESTONE, id, "70002", "ACK-70002", jira)
            val first = admin.ackItem(f.connectionId, binding)
            assertEquals(1, first.deviations.size, "END_DIFFERS")
            val given = w.projectOwner.client.ack(binding, first.fingerprint).acknowledgement()

            // A change that alters no deviation (the man-day estimate has no Jira counterpart here) keeps it acknowledged.
            jbSql("UPDATE milestones SET estimate_md = 5 WHERE id = ?", id.toInt())
            assertTrue(assertNotNull(admin.ackItem(f.connectionId, binding).acknowledgement).current)

            // The plan moves the end further: another detail, another fingerprint.
            TestPlan.schedule(id, "2044-02-01", "2044-02-11")
            val reopened = admin.ackItem(f.connectionId, binding)
            val stamp = assertNotNull(reopened.acknowledgement)
            assertEquals(listOf(given.acknowledgedAt, given.acknowledgedBy, false), listOf(stamp.at, stamp.by, stamp.current))
            assertFalse(reopened.fingerprint == first.fingerprint)
            assertEquals(listOf(binding), admin.dvView("connectionId=${f.connectionId}").items.map { it.bindingId }, "open again")
            assertTrue(admin.dvView("connectionId=${f.connectionId}&acknowledged=true").items.isEmpty())
            assertEquals(0, admin.dvView("connectionId=${f.connectionId}").totals.acknowledged)
            val replay = w.projectOwner.client.ack(binding, first.fingerprint)
            assertEquals(HttpStatusCode.Conflict, replay.status, "the old fingerprint is stale now")

            // Jira's side moves too: back to the first plan end, Jira's end later - the list changes again.
            val again = w.projectOwner.client.ack(binding, reopened.fingerprint).acknowledgement()
            assertTrue(assertNotNull(admin.ackItem(f.connectionId, binding).acknowledgement).current)
            jbSql("UPDATE jira_observations SET end_date = DATE '2044-02-10' WHERE binding_id = ?", binding.toInt())
            val moved = admin.ackItem(f.connectionId, binding)
            val stale = assertNotNull(moved.acknowledgement)
            assertFalse(stale.current)
            assertEquals(again.acknowledgedAt, stale.at)
        }

    @Test
    fun `withdrawing is 204 then 404, a stranger is 403 before the 404, and the view shows no acknowledgement again`() = testApplication {
        val f = fixture("ack7")
        val w = f.w
        val admin = w.admin.client
        val binding = deviatingBinding(f.connectionId, JiraLevel.PROJECT, w.projectId)
        assertEquals(HttpStatusCode.NotFound, admin.unack(binding).status, "nothing stored")
        assertEquals(HttpStatusCode.Forbidden, w.stranger.client.unack(binding).status, "the guard comes before 'nothing stored'")
        admin.ack(binding, f.fingerprint(binding)).acknowledgement()
        assertEquals(HttpStatusCode.Forbidden, w.stranger.client.unack(binding).status)
        assertEquals(HttpStatusCode.NoContent, w.programOwner.client.unack(binding).status)
        assertNull(admin.ackItem(f.connectionId, binding).acknowledgement)
        assertEquals(HttpStatusCode.NotFound, admin.unack(binding).status)
        assertEquals(listOf(binding), admin.dvView("connectionId=${f.connectionId}").items.map { it.bindingId }, "open again")
        // A STALE acknowledgement is withdrawn the same way.
        admin.ack(binding, f.fingerprint(binding)).acknowledgement()
        jbSql("UPDATE jira_observations SET summary = 'moved on' WHERE binding_id = ?", binding.toInt())
        assertFalse(assertNotNull(admin.ackItem(f.connectionId, binding).acknowledgement).current)
        assertEquals(HttpStatusCode.NoContent, admin.unack(binding).status)
    }

    @Test
    fun `the audit lines name who, what and each line, after the commit - a refused request audits nothing`() = testApplication {
        val f = fixture("ack8")
        val w = f.w
        val binding = deviatingBinding(f.connectionId, JiraLevel.MILESTONE, f.milestone)
        val fingerprint = f.fingerprint(binding)
        val item = w.admin.client.ackItem(f.connectionId, binding)
        withAuditCapture { audit ->
            assertEquals(HttpStatusCode.Forbidden, w.stranger.client.ack(binding, fingerprint).status)
            assertEquals(HttpStatusCode.Conflict, w.admin.client.ack(binding, "1".repeat(64)).status)
            assertEquals(HttpStatusCode.NotFound, w.admin.client.unack(binding).status)
            assertEquals(HttpStatusCode.OK, w.projectOwner.client.ack(binding, fingerprint).status)
            val acknowledged = assertNotNull(
                audit.awaitEvent { it.message == "jira.deviation_acknowledged" && it.hasKeyValue("bindingId", binding.toLong()) },
            )
            val line = item.deviations.single()
            assertEquals(
                listOf(true, true, true, true, true, true, true),
                listOf(
                    acknowledged.hasKeyValue("byUserId", w.projectOwner.userId.toLong()),
                    acknowledged.hasKeyValue("connectionId", f.connectionId.toLong()),
                    acknowledged.hasKeyValue("level", "MILESTONE"),
                    acknowledged.hasKeyValue("nodeId", f.milestone.toLong()),
                    acknowledged.hasKeyValue("issueKey", item.jira.key),
                    acknowledged.hasKeyValue("kind", line.kind.name),
                    acknowledged.hasKeyValue("severity", line.severity.name),
                ),
            )
            val stored = storedAcks(binding).getValue(line.kind.name)
            assertTrue(acknowledged.hasKeyValue("fingerprint", stored.fingerprint), "the LINE's fingerprint")
            val batch = assertNotNull(
                audit.awaitEvent { it.message == "jira.deviations_acknowledged" && it.hasKeyValue("bindingId", binding.toLong()) },
            )
            assertTrue(batch.hasKeyValue("listFingerprint", fingerprint) && batch.hasKeyValue("count", 1))
            assertTrue(batch.hasKeyValue("kinds", line.kind.name) && batch.hasKeyValue("bindingId", binding.toLong()))
            assertTrue(audit.events.indexOf(batch) < audit.events.indexOf(acknowledged), "the batch line comes before the row lines")

            assertEquals(HttpStatusCode.NoContent, w.programOwner.client.unack(binding).status)
            val withdrawn = assertNotNull(
                audit.awaitEvent { it.message == "jira.deviation_unacknowledged" && it.hasKeyValue("bindingId", binding.toLong()) },
            )
            assertTrue(withdrawn.hasKeyValue("byUserId", w.programOwner.userId.toLong()))
            assertTrue(withdrawn.hasKeyValue("kind", line.kind.name) && withdrawn.hasKeyValue("fingerprint", stored.fingerprint))
            val batchWithdrawn = assertNotNull(
                audit.awaitEvent { it.message == "jira.deviations_unacknowledged" && it.hasKeyValue("bindingId", binding.toLong()) },
            )
            assertTrue(batchWithdrawn.hasKeyValue("count", 1))
            assertEquals(1, audit.events.count { it.message == "jira.deviation_acknowledged" }, "the 403 and the 409 audited nothing")
            assertEquals(1, audit.events.count { it.message == "jira.deviation_unacknowledged" }, "the 404 audited nothing")
        }
    }

    @Test
    fun `acknowledging moves no plan revision`() = testApplication {
        val f = fixture("ack9")
        val binding = deviatingBinding(f.connectionId, JiraLevel.PROJECT, f.w.projectId)
        val revision = TestPlan.revision()
        f.w.admin.client.ack(binding, f.fingerprint(binding)).acknowledgement()
        f.w.admin.client.unack(binding)
        assertEquals(revision, TestPlan.revision(), "an acknowledgement is not plan state")
    }

    @Test
    fun `a coverage deviation is acknowledged and reopens when a new unbound epic appears in the census`() = testApplication {
        val f = fixture("ack10")
        val admin = f.w.admin.client
        val project = TestPlan.project(f.w.programId, f.w.projectOwner.personId!!)
        val name = TestPlan.scalar("SELECT name FROM projects WHERE id = $project") { it.getString(1) }
        val binding = dvBind(f.connectionId, JiraLevel.PROJECT, project, "80001", "ACK-80001", DvObs(name, 2))
        assertTrue(admin.ackItem(f.connectionId, binding).deviations.isEmpty(), "a clean project, nothing under it")
        dvMirror(f.connectionId, "80002", level = 1, parent = "80001")

        val item = admin.ackItem(f.connectionId, binding)
        assertEquals(setOf(ch.nokillswit.planning.DeviationKind.UNLINKED_IN_JIRA), item.kindSet())
        assertEquals(binding, admin.ack(binding, item.fingerprint).acknowledgement().bindingId, "the write recomputes the very same list")
        assertTrue(assertNotNull(admin.ackItem(f.connectionId, binding).acknowledgement).current)
        assertTrue(admin.dvView("connectionId=${f.connectionId}").items.none { it.bindingId == binding }, "acknowledged: not open")

        dvMirror(f.connectionId, "80003", level = 1, parent = "80001")
        val reopened = admin.ackItem(f.connectionId, binding)
        assertEquals(false, assertNotNull(reopened.acknowledgement).current, "a new unplanned epic changes the list")
        assertTrue(reopened.fingerprint != item.fingerprint)
        assertTrue(admin.dvView("connectionId=${f.connectionId}").items.any { it.bindingId == binding }, "and the item is open again")
        assertEquals(HttpStatusCode.Conflict, admin.ack(binding, item.fingerprint).status, "the old fingerprint is stale now")
    }
}
