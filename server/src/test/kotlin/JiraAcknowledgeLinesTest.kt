package ch.nokillswit

import ch.nokillswit.jira.DeviationLine
import ch.nokillswit.jira.fingerprintOf
import ch.nokillswit.planning.Deviation
import ch.nokillswit.planning.DeviationKind
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
 * 1.12's per-deviation acknowledgement on a seeded world (`twoLineBinding`: `END_DIFFERS` WARNING and `RENAMED` INFO): one line on its
 * own, the kind-less form, the pre-1.12 body, the stale and unknown-kind refusals, the withdrawals, a returning line (nothing is
 * pruned) and the audience (a manager whose person was unlinked). The audit lines are in `JiraAcknowledgeTest`, the view's reading in
 * `DeviationViewAckTest`, the held requests in `JiraAcknowledgeRaceTest`.
 */
class JiraAcknowledgeLinesTest {
    private val ledger = ConnectionLedger()

    @After
    fun dropConnections() = ledger.drop()

    private class Fixture(val w: PlanWorld, val c: UInt) {
        val admin get() = w.admin.client
        val owner get() = w.projectOwner.client

        suspend fun two(): TwoLines = twoLineBinding(c, w.projectId, w.requireTeams().teamId)

        suspend fun item(binding: UInt) = admin.ackItem(c, binding)
    }

    private suspend fun ApplicationTestBuilder.fixture(prefix: String): Fixture {
        usePostgresTestcontainer()
        val w = planWorld(prefix, teams = true)
        return Fixture(w, ledger.track(w.admin.client.dvConnection()))
    }

    private fun lineFingerprint(line: DeviationLine) = fingerprintOf(Deviation(line.kind, line.severity, line.detail))

    private val end = DeviationKind.END_DIFFERS
    private val renamed = DeviationKind.RENAMED

    @Test
    fun `one line is acknowledged on its own, with its own fingerprint, and the other stays open`() = testApplication {
        val f = fixture("akl1")
        val two = f.two()
        val item = f.item(two.binding)
        assertEquals(listOf(end, renamed), item.deviations.map { it.kind }, "WARNING first")

        val given = f.owner.ack(two.binding, item.fingerprint, end).acknowledgement()
        assertEquals(listOf(two.binding, end, item.fingerprint), listOf(given.bindingId, given.kind, given.fingerprint))
        val stored = storedAcks(two.binding)
        assertEquals(setOf(end.name), stored.keys, "one row, for the requested line")
        val row = stored.getValue(end.name)
        assertEquals(lineFingerprint(item.deviations.first()), row.fingerprint, "the LINE's fingerprint is stored")
        assertFalse(row.fingerprint == item.fingerprint)
        assertEquals(listOf(given.acknowledgedAt, f.w.projectOwner.userId.toLong()), listOf(row.at, row.byUserId))

        val after = f.item(two.binding)
        assertEquals(mapOf(end to true, renamed to null), after.lineStates())
        assertEquals(item.fingerprint, after.fingerprint, "the token a client echoes does not move")
        assertEquals(false, assertNotNull(after.acknowledgement, "the deprecated summary").current, "not every listed line is current")
        val ownerName = TestPlan.scalar("SELECT name FROM people WHERE id = ${f.w.projectOwner.personId}") { it.getString(1) }
        assertEquals(ownerName, after.deviations.first().acknowledgement?.by)

        val open = f.admin.dvView("connectionId=${f.c}")
        assertEquals(listOf(two.binding), open.items.map { it.bindingId }, "RENAMED is still open")
        assertEquals(listOf(0, 1, 1, 0, 1), with(open.totals) { listOf(warnings, infos, bindings, gone, acknowledged) })
        assertEquals(1L, jbScalar("SELECT updated_at FROM jira_bindings WHERE id = ?", two.binding.toInt()) { it.getLong(1) }, "untouched")

        f.owner.ack(two.binding, item.fingerprint, renamed).acknowledgement()
        assertTrue(f.admin.dvView("connectionId=${f.c}").items.isEmpty(), "every line acknowledged: the binding leaves the open list")
        assertTrue(assertNotNull(f.item(two.binding).acknowledgement).current)
    }

    @Test
    fun `without a kind the call stamps the lines without a current acknowledgement, all of them when each has one`() = testApplication {
        val f = fixture("akl2")
        val two = f.two()
        val fingerprint = f.item(two.binding).fingerprint
        val first = f.owner.ack(two.binding, fingerprint, end).acknowledgement()
        val second = f.admin.ack(two.binding, fingerprint).acknowledgement()
        assertNull(second.kind)
        assertEquals(fingerprint, second.fingerprint)
        val mixed = storedAcks(two.binding)
        assertEquals(first.acknowledgedAt, mixed.getValue(end.name).at, "the already acknowledged line is left alone")
        assertEquals(second.acknowledgedAt, mixed.getValue(renamed.name).at)
        assertEquals(f.w.projectOwner.userId.toLong(), mixed.getValue(end.name).byUserId, "still the owner's stamp")
        assertEquals(f.w.admin.userId.toLong(), mixed.getValue(renamed.name).byUserId)

        val third = f.admin.ack(two.binding, fingerprint).acknowledgement()
        val all = storedAcks(two.binding)
        assertEquals(listOf(third.acknowledgedAt, third.acknowledgedAt), listOf(end, renamed).map { all.getValue(it.name).at }, "restamped")
        assertEquals(f.w.admin.userId.toLong(), all.getValue(end.name).byUserId, "the END row is the admin's now")
        assertEquals(setOf(end.name, renamed.name), all.keys, "still one row per kind")
    }

    @Test
    fun `the pre-1_12 body acknowledges a fresh item as one call did before`() = testApplication {
        val f = fixture("akl3")
        val two = f.two()
        val fingerprint = f.item(two.binding).fingerprint
        val response = f.owner.ackRaw(two.binding, """{"fingerprint":"$fingerprint"}""")
        val given = response.acknowledgement()
        assertEquals(listOf(null, fingerprint), listOf(given.kind, given.fingerprint))
        val item = f.item(two.binding)
        assertEquals(mapOf(end to true, renamed to true), item.lineStates())
        assertEquals(listOf(given.acknowledgedAt, true), assertNotNull(item.acknowledgement).let { listOf(it.at, it.current) })
        assertTrue(f.admin.dvView("connectionId=${f.c}").items.isEmpty())
        assertEquals(setOf(end.name, renamed.name), storedAcks(two.binding).keys)
    }

    @Test
    fun `a kind the list does not hold, a stale fingerprint or an unknown kind refuses and stores nothing`() = testApplication {
        val f = fixture("akl4")
        val two = f.two()
        val fingerprint = f.item(two.binding).fingerprint
        val absent = f.owner.ack(two.binding, fingerprint, DeviationKind.GONE)
        assertEquals(HttpStatusCode.Conflict, absent.status, "GONE is not in this list")
        assertEquals(STALE_DEVIATIONS_PROBLEM, absent.jbProblem().type)
        assertEquals(HttpStatusCode.Conflict, f.owner.ack(two.binding, "0".repeat(64), end).status, "a stale list fingerprint")
        val body = """{"fingerprint":"$fingerprint","kind":"NOT_A_KIND"}"""
        assertEquals(HttpStatusCode.BadRequest, f.owner.ackRaw(two.binding, body).status, "an unknown kind is a 400 for the owner")
        assertEquals(HttpStatusCode.Forbidden, f.w.stranger.client.ackRaw(two.binding, body).status, "and 403 for a stranger, first")
        assertEquals(HttpStatusCode.NotFound, f.owner.ackRaw(999_999u, body).status, "404 before everything")
        assertTrue(storedAcks(two.binding).isEmpty())
    }

    @Test
    fun `withdrawing one line leaves the others, withdrawing without a kind clears every row, each is 404 once nothing is stored`() =
        testApplication {
            val f = fixture("akl5")
            val two = f.two()
            val fingerprint = f.item(two.binding).fingerprint
            f.owner.ack(two.binding, fingerprint).acknowledgement()
            storeRetiredAck(two.binding, f.w.projectOwner.userId)

            assertEquals(HttpStatusCode.NoContent, f.owner.unack(two.binding, end).status)
            assertEquals(setOf(renamed.name, "RETIRED_KIND"), storedAcks(two.binding).keys)
            assertEquals(mapOf(end to null, renamed to true), f.item(two.binding).lineStates())
            assertEquals(HttpStatusCode.NotFound, f.owner.unack(two.binding, end).status, "that line has nothing stored")
            assertEquals(HttpStatusCode.NotFound, f.owner.unack(two.binding, DeviationKind.GONE).status, "a kind never stored")

            assertEquals(HttpStatusCode.NoContent, f.owner.unack(two.binding).status, "every stored row, a retired kind's included")
            assertTrue(storedAcks(two.binding).isEmpty())
            assertEquals(HttpStatusCode.NotFound, f.owner.unack(two.binding).status)

            // A stale row is withdrawn like a current one, and a retired kind alone is a row to clear too.
            f.owner.ack(two.binding, fingerprint, renamed).acknowledgement()
            jbSql("UPDATE jira_observations SET summary = 'moved on' WHERE binding_id = ?", two.binding.toInt())
            assertEquals(mapOf(end to null, renamed to false), f.item(two.binding).lineStates())
            assertEquals(HttpStatusCode.NoContent, f.owner.unack(two.binding, renamed).status)
            storeRetiredAck(two.binding, f.w.projectOwner.userId)
            assertEquals(mapOf(end to null, renamed to null), f.item(two.binding).lineStates(), "a retired kind is ignored on read")
            assertEquals(HttpStatusCode.NoContent, f.owner.unack(two.binding).status)
        }

    @Test
    fun `the kind parameter of the withdrawal is parsed after the guard - 404 then 403 then 400`() = testApplication {
        val f = fixture("akl6")
        val two = f.two()
        f.owner.ack(two.binding, f.item(two.binding).fingerprint).acknowledgement()
        assertEquals(HttpStatusCode.NotFound, f.owner.unackRaw(999_999u, "kind=NOT_A_KIND").status)
        assertEquals(HttpStatusCode.NotFound, f.owner.unackRaw(999_999u, "kinds=RENAMED").status, "an unknown name is no exception")
        assertEquals(HttpStatusCode.Forbidden, f.w.stranger.client.unackRaw(two.binding, "kind=NOT_A_KIND").status)
        assertEquals(HttpStatusCode.Forbidden, f.w.stranger.client.unackRaw(two.binding, "kinds=RENAMED").status, "403 before the 400")
        for (query in listOf("kind=NOT_A_KIND", "kind=", "kind", "kind=RENAMED&kind=END_DIFFERS", "kind=renamed")) {
            assertEquals(HttpStatusCode.BadRequest, f.owner.unackRaw(two.binding, query).status, query)
        }
        assertEquals(setOf(end.name, renamed.name), storedAcks(two.binding).keys, "nothing was withdrawn")
    }

    @Test
    fun `a query parameter of any other name fails closed with a 400 and withdraws nothing`() = testApplication {
        val f = fixture("akl6b")
        val two = f.two()
        f.owner.ack(two.binding, f.item(two.binding).fingerprint).acknowledgement()
        val misspelt = listOf("kinds=RENAMED", "kind[]=RENAMED", "Kind=RENAMED", "kinds", "force=true", "kind=RENAMED&kinds=END_DIFFERS")
        for (query in misspelt) {
            for (caller in listOf(f.owner, f.admin)) {
                val response = caller.unackRaw(two.binding, query)
                assertEquals(HttpStatusCode.BadRequest, response.status, query)
                assertTrue(response.jbProblem().detail.orEmpty().contains("query parameter"), query)
            }
        }
        assertEquals(setOf(end.name, renamed.name), storedAcks(two.binding).keys, "every acknowledgement is still stored")
        assertEquals(HttpStatusCode.NoContent, f.owner.unackRaw(two.binding, "kind=RENAMED").status, "the right name still works")
        assertEquals(setOf(end.name), storedAcks(two.binding).keys)
    }

    @Test
    fun `the per-line forms audit exactly one row line and no batch line, the kind-less forms a batch line before the row lines`() =
        testApplication {
            val f = fixture("akl9")
            val two = f.two()
            val fingerprint = f.item(two.binding).fingerprint
            withAuditCapture { audit ->
                fun lines(name: String) = audit.events.filter { it.message == name && it.hasKeyValue("bindingId", two.binding.toLong()) }

                f.owner.ack(two.binding, fingerprint, end).acknowledgement()
                val stamped = assertNotNull(audit.awaitEvent { it.message == "jira.deviation_acknowledged" })
                assertEquals(listOf(stamped), lines("jira.deviation_acknowledged"), "exactly one row line")
                assertTrue(stamped.hasKeyValue("kind", end.name) && stamped.hasKeyValue("byUserId", f.w.projectOwner.userId.toLong()))
                assertTrue(lines("jira.deviations_acknowledged").isEmpty(), "a per-line POST writes no batch line")

                assertEquals(HttpStatusCode.NoContent, f.owner.unack(two.binding, end).status)
                val cleared = lines("jira.deviation_unacknowledged").single()
                assertTrue(cleared.hasKeyValue("kind", end.name) && cleared.hasKeyValue("byUserId", f.w.projectOwner.userId.toLong()))
                assertTrue(lines("jira.deviations_unacknowledged").isEmpty(), "a per-line DELETE writes no batch line")

                f.admin.ack(two.binding, fingerprint).acknowledgement()
                val batch = lines("jira.deviations_acknowledged").single()
                val rows = lines("jira.deviation_acknowledged").drop(1)
                assertEquals(setOf(end.name, renamed.name), rows.map { it.keyValuePairs.first { kv -> kv.key == "kind" }.value }.toSet())
                assertTrue(batch.hasKeyValue("count", 2) && batch.hasKeyValue("listFingerprint", fingerprint))
                assertTrue(batch.hasKeyValue("byUserId", f.w.admin.userId.toLong()))
                val rowKinds = rows.joinToString(",") { it.keyValuePairs.first { kv -> kv.key == "kind" }.value.toString() }
                assertTrue(batch.hasKeyValue("kinds", rowKinds), "the batch line names the row lines' kinds in order")
                assertTrue(rows.all { audit.events.indexOf(batch) < audit.events.indexOf(it) }, "the batch line comes first")

                assertEquals(HttpStatusCode.NoContent, f.owner.unack(two.binding).status)
                val batchCleared = lines("jira.deviations_unacknowledged").single()
                val clearedRows = lines("jira.deviation_unacknowledged").drop(1)
                assertEquals(2, clearedRows.size)
                assertTrue(batchCleared.hasKeyValue("count", 2) && batchCleared.hasKeyValue("byUserId", f.w.projectOwner.userId.toLong()))
                val clearedKinds = clearedRows.joinToString(",") { it.keyValuePairs.first { kv -> kv.key == "kind" }.value.toString() }
                assertTrue(batchCleared.hasKeyValue("kinds", clearedKinds))
                assertEquals(setOf(end.name, renamed.name), clearedKinds.split(",").toSet())
                assertTrue(clearedRows.all { audit.events.indexOf(batchCleared) < audit.events.indexOf(it) }, "the batch line comes first")
            }
        }

    @Test
    fun `a refused acknowledge or withdrawal at the outer guard is the central authz_denied and no acknowledge line`() = testApplication {
        val f = fixture("akl10")
        val two = f.two()
        val fingerprint = f.item(two.binding).fingerprint
        val stranger = f.w.stranger
        withAuditCapture { audit ->
            assertEquals(HttpStatusCode.Forbidden, stranger.client.ack(two.binding, fingerprint, end).status)
            val denied = assertNotNull(
                audit.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("path", ackUrl(two.binding)) },
                "the refused POST",
            )
            assertTrue(denied.hasKeyValue("method", "POST") && denied.hasKeyValue("byUserId", stranger.userId.toLong()))
            assertEquals(HttpStatusCode.Forbidden, stranger.client.unack(two.binding, end).status)
            val deniedDelete = assertNotNull(
                audit.awaitEvent {
                    it.message == "authz.denied" && it.hasKeyValue("method", "DELETE") && it.hasKeyValue("path", ackUrl(two.binding))
                },
                "the refused DELETE",
            )
            assertTrue(deniedDelete.hasKeyValue("byUserId", stranger.userId.toLong()), "the path carries no query string")
            val acknowledgeLines = audit.events.filter { it.message.orEmpty().startsWith("jira.deviation") }
            assertTrue(acknowledgeLines.none { it.hasKeyValue("bindingId", two.binding.toLong()) }, "a refused request writes no line")
        }
        assertTrue(storedAcks(two.binding).isEmpty())
    }

    @Test
    fun `a change to one line reopens that line only, and a line that leaves and returns identical is still acknowledged`() =
        testApplication {
            val f = fixture("akl7")
            val two = f.two()
            val given = f.owner.ack(two.binding, f.item(two.binding).fingerprint).acknowledgement()

            // The plan moves its end further: END_DIFFERS has another detail, RENAMED is untouched.
            TestPlan.schedule(two.milestone, "2044-02-01", "2044-02-11")
            val moved = f.item(two.binding)
            assertEquals(mapOf(end to false, renamed to true), moved.lineStates())
            assertEquals(given.acknowledgedAt, moved.deviations.first().acknowledgement?.at, "the old stamp")
            assertEquals(listOf(two.binding), f.admin.dvView("connectionId=${f.c}").items.map { it.bindingId }, "open again")
            assertEquals(1, f.admin.dvView("connectionId=${f.c}").totals.warnings, "only the reopened line counts")

            // Jira's end now equals the plan's: END_DIFFERS leaves the list and the row stays (nothing is pruned)...
            jbSql("UPDATE jira_observations SET end_date = DATE '2044-02-11' WHERE binding_id = ?", two.binding.toInt())
            assertEquals(mapOf(renamed to true), f.item(two.binding).lineStates())
            assertTrue(f.admin.dvView("connectionId=${f.c}").items.isEmpty(), "the one listed line is acknowledged")
            assertEquals(setOf(end.name, renamed.name), storedAcks(two.binding).keys)

            // ...and when the line is raised again with the very detail it was acknowledged on, it reads acknowledged again.
            TestPlan.schedule(two.milestone, "2044-02-01", "2044-02-09")
            jbSql("UPDATE jira_observations SET end_date = DATE '2044-02-04' WHERE binding_id = ?", two.binding.toInt())
            val back = f.item(two.binding)
            assertEquals(mapOf(end to true, renamed to true), back.lineStates())
            assertEquals(given.acknowledgedAt, back.deviations.first().acknowledgement?.at, "the original stamp")
            assertTrue(f.admin.dvView("connectionId=${f.c}").items.isEmpty())
        }

    @Test
    fun `a team manager whose person was unlinked from the login, or deleted, can neither see nor use the acknowledge`() = testApplication {
        val f = fixture("akl8")
        val manager = f.w.requireTeams().manager
        val two = f.two()
        val fingerprint = f.item(two.binding).fingerprint
        suspend fun can() = manager.client.dvView("connectionId=${f.c}").byBinding()[two.binding]?.can?.acknowledge
        assertEquals(true, can(), "the linked manager may")
        manager.client.ack(two.binding, fingerprint, end).acknowledgement()
        assertEquals(HttpStatusCode.NoContent, manager.client.unack(two.binding).status)

        jbSql("UPDATE people SET user_id = NULL WHERE id = ?", manager.personId!!.toInt())
        assertEquals(false, can(), "the person no longer belongs to the login")
        assertEquals(HttpStatusCode.Forbidden, manager.client.ack(two.binding, fingerprint, end).status)
        assertEquals(HttpStatusCode.Forbidden, manager.client.unack(two.binding).status)

        jbSql("UPDATE people SET user_id = ? WHERE id = ?", manager.userId.toInt(), manager.personId.toInt())
        assertEquals(true, can(), "linked again")
        TestPeople.softDelete(manager.personId)
        assertEquals(false, can(), "a deleted person manages nothing")
        assertEquals(HttpStatusCode.Forbidden, manager.client.ack(two.binding, fingerprint).status)
        assertEquals(HttpStatusCode.Forbidden, manager.client.unack(two.binding).status)
        assertTrue(storedAcks(two.binding).isEmpty(), "the refused calls stored nothing")
    }
}
