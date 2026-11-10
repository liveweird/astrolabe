package ch.nokillswit

import ch.nokillswit.flow.CapacityDeviationFilter
import ch.nokillswit.flow.CapacityDeviationKind
import ch.nokillswit.flow.CapacityDeviationService
import ch.nokillswit.flow.CapacityDeviationTotals
import ch.nokillswit.flow.CapacityDeviationView
import ch.nokillswit.planning.DeviationSeverity
import ch.nokillswit.planning.loadWorkingCalendar
import ch.nokillswit.teams.TeamCapacityService
import ch.nokillswit.teams.TeamService
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /views/capacity-deviations` with the stored acknowledgements (1.9): `acknowledgement{at, by, current}` on a row, `can.acknowledge`
 * on an item, `totals.acknowledged`, and the Jira deviations view's listing rule (the default lists OPEN rows; `acknowledged=true|false`;
 * `all`, which `teamId` implies unless `all=false`). The world is `CapacityAcknowledgeTest`'s ([capAckWorld], a scripted Flow): on day
 * two the team's sprint 2 is a WARNING (+6.00), its sprint 3 an INFO (-4.00) and "Billing" - linked to the other team - is gone (a
 * WARNING). The write itself is `CapacityAcknowledgeTest`'s; here acknowledgements are stamped through it and read back.
 */
class CapacityDeviationAckViewTest {
    private val mirrors = mutableListOf<ScriptedFlowMirror>()

    @AfterTest
    fun cleanUp() {
        mirrors.forEach { it.cleanUp() }
        mirrors.clear()
        removeFlowFixtureRows(CAPACK_PREFIX)
    }

    private suspend fun ApplicationTestBuilder.dayTwo(label: String): CapAckWorld = capAckWorld(label, mirrors).also { it.refresh() }

    /** The view of this world's connection with [query] (`"&all=true"`, …), as [this] caller reads it. */
    private suspend fun HttpClient.view(world: CapAckWorld, query: String = ""): CapacityDeviationView {
        val response = get("/api/v1/views/capacity-deviations?connectionId=${world.mirror.connectionId}$query")
        assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
        return fbJson.decodeFromString(response.bodyAsText())
    }

    private fun CapacityDeviationView.rows(): List<Pair<UInt, Long?>> =
        items.flatMap { item -> item.deviations.map { item.bindingId to it.detail.sprintId } }

    private fun CapacityDeviationTotals.asList() = listOf(warnings, infos, gone, acknowledged, teams)

    @Test
    fun `an acknowledged row leaves the default list - acknowledged, all and teamId bring it back`() =
        testApplication {
            val world = dayTwo("capack-v1")
            with(world) {
                val admin = w.admin.client
                val teamOnly = "&teamId=$teamId"
                val before = admin.view(world)
                assertEquals(setOf(bindingId to 2L, bindingId to 3L, billingBindingId to null), before.rows().toSet())
                assertEquals(listOf(2, 1, 1, 0, 2), before.totals.asList(), "warnings, infos, gone, acknowledged, teams")
                assertTrue(before.items.flatMap { it.deviations }.all { it.acknowledgement == null })

                val info = admin.rowOf(3)
                val ack = manager.client.capAck(bindingId, 3, info.fingerprint).capAcknowledgement()
                val personName = jbScalar("SELECT name FROM people WHERE id = ?", manager.personId!!.toInt()) { it.getString(1) }

                val open = admin.view(world)
                assertEquals(setOf(bindingId to 2L, billingBindingId to null), open.rows().toSet(), "the default lists OPEN rows only")
                assertEquals(listOf(2, 0, 1, 1, 2), open.totals.asList())

                val acknowledged = admin.view(world, "&acknowledged=true")
                assertEquals(listOf(bindingId to 3L), acknowledged.rows())
                val row = acknowledged.items.single().deviations.single()
                assertEquals(ack.acknowledgedAt, row.acknowledgement?.at)
                assertEquals(personName, row.acknowledgement?.by, "the manager is named by their person")
                assertEquals(true, row.acknowledgement?.current)
                assertEquals(listOf(2, 0, 1, 1, 1), acknowledged.totals.asList(), "the open counts survive acknowledged=true")

                val everything = admin.view(world, "&all=true")
                assertEquals(setOf(bindingId to 2L, bindingId to 3L, billingBindingId to null), everything.rows().toSet())
                assertEquals(listOf(2, 0, 1, 1, 2), everything.totals.asList())
                assertNull(everything.items.flatMap { it.deviations }.single { it.detail.sprintId == 2L }.acknowledgement)

                val team = admin.view(world, teamOnly)
                assertEquals(listOf(bindingId to 2L, bindingId to 3L), team.rows(), "teamId implies all")
                assertEquals(listOf(1, 0, 0, 1, 1), team.totals.asList(), "the totals count the one team in scope")
                val teamOpen = admin.view(world, "$teamOnly&all=false")
                assertEquals(listOf(bindingId to 2L), teamOpen.rows(), "all=false overrides the implication")
                assertEquals(listOf(1, 0, 0, 1, 1), teamOpen.totals.asList())
                assertEquals(
                    listOf(bindingId to 2L),
                    admin.view(world, "$teamOnly&acknowledged=false").rows(),
                    "acknowledged=false lists the open rows",
                )
                assertEquals(setOf(bindingId to 2L, billingBindingId to null), admin.view(world, "&acknowledged=false").rows().toSet())

                // The only other row of the team is acknowledged too: the team is not listed by default.
                manager.client.capAck(bindingId, 2, admin.rowOf(2).fingerprint).capAcknowledgement()
                val gone = admin.view(world)
                assertEquals(listOf(billingBindingId to null), gone.rows(), "a team whose rows are all acknowledged is not listed")
                assertEquals(listOf(1, 0, 1, 2, 1), gone.totals.asList())
                assertEquals(listOf(bindingId to 2L, bindingId to 3L), admin.view(world, "&acknowledged=true").rows())
            }
        }

    @Test
    fun `a team with an OPEN warning sorts before one whose warnings are acknowledged`() = testApplication {
        val world = dayTwo("capack-v2")
        with(world) {
            val admin = w.admin.client
            val otherManager = w.requireTeams().otherManager
            // Billing's gone row acknowledged: the E2E team (an open WARNING, sprint 2) comes first whatever the names say.
            otherManager.client.capAck(billingBindingId, null, admin.rowOf(null, billingBindingId).fingerprint).capAcknowledgement()
            assertEquals(listOf(bindingId, billingBindingId), admin.view(world, "&all=true").items.map { it.bindingId })
            // And the other way round: sprint 2 acknowledged, Billing's gone row open again.
            manager.client.capAck(bindingId, 2, admin.rowOf(2).fingerprint).capAcknowledgement()
            otherManager.client.capUnack(billingBindingId).also { assertEquals(HttpStatusCode.NoContent, it.status) }
            assertEquals(listOf(billingBindingId, bindingId), admin.view(world, "&all=true").items.map { it.bindingId })
        }
    }

    @Test
    fun `a figure changed after the acknowledgement turns current false - open again, by and at kept`() = testApplication {
        val world = dayTwo("capack-v3")
        with(world) {
            val admin = w.admin.client
            val seen = admin.rowOf(2)
            val ack = manager.client.capAck(bindingId, 2, seen.fingerprint).capAcknowledgement()
            assertEquals(false, admin.view(world).rows().contains(bindingId to 2L), "acknowledged: off the default list")

            // The plan's figure for sprint 2 moves (a capacity edit by the team): the stored fingerprint is no longer the row's.
            jbSql("UPDATE team_capacity_periods SET md_per_week = 17 WHERE team_id = ? AND flow_sprint_id = 2", teamId.toInt())
            val moved = admin.rowOf(2)
            assertNotEquals(seen.fingerprint, moved.fingerprint)
            val stale = assertNotNull(moved.acknowledgement)
            assertFalse(stale.current)
            assertEquals(ack.acknowledgedAt, stale.at)
            assertEquals(ack.acknowledgedBy, stale.by)

            val open = admin.view(world)
            assertTrue(open.rows().contains(bindingId to 2L), "a stale acknowledgement is open again: on the default list")
            assertEquals(0, open.totals.acknowledged)
            assertEquals(emptyList(), admin.view(world, "&acknowledged=true").rows(), "nothing is CURRENTLY acknowledged")
            assertTrue(admin.view(world, "&acknowledged=false").rows().contains(bindingId to 2L))
            val reopened = open.items.flatMap { it.deviations }.single { it.detail.sprintId == 2L }
            assertEquals(CapacityDeviationKind.CAPACITY_DIFFERS, reopened.kind)

            // Acknowledging what is read now is current again; the other sprint was never touched.
            manager.client.capAck(bindingId, 2, moved.fingerprint).capAcknowledgement()
            assertTrue(assertNotNull(admin.rowOf(2).acknowledgement).current)
            assertNull(admin.rowOf(3).acknowledgement)
        }
    }

    @Test
    fun `can_acknowledge is ADMIN or the team's active manager, per item`() = testApplication {
        val world = dayTwo("capack-v4")
        with(world) {
            val others = w.requireTeams().otherManager
            fun CapacityDeviationView.can() = items.associate { it.bindingId to it.can.acknowledge }
            assertEquals(mapOf(bindingId to true, billingBindingId to true), w.admin.client.view(world).can(), "ADMIN: everywhere")
            assertEquals(mapOf(bindingId to true, billingBindingId to false), manager.client.view(world).can(), "the team's manager")
            assertEquals(mapOf(bindingId to false, billingBindingId to true), others.client.view(world).can(), "the other team's manager")
            val nobody = listOf("stranger" to w.stranger, "person-less" to w.personless, "owner" to w.projectOwner, "editor" to w.editor)
            for ((who, caller) in nobody) {
                assertEquals(mapOf(bindingId to false, billingBindingId to false), caller.client.view(world).can(), who)
            }
            // A manager cleared from the team no longer may.
            jbSql("UPDATE teams SET manager_person_id = NULL WHERE id = ?", teamId.toInt())
            assertEquals(false, manager.client.view(world).can().getValue(bindingId), "the guard reads the CURRENT manager")
        }
    }

    @Test
    fun `a manager whose person or login is soft-deleted may not acknowledge`() = testApplication {
        val world = dayTwo("capack-v4b")
        with(world) {
            val others = w.requireTeams().otherManager
            fun CapacityDeviationView.can() = items.associate { it.bindingId to it.can.acknowledge }
            // The person is gone: the login still reads, and the guard (an ACTIVE person linked to the login) says no.
            TestPeople.softDelete(manager.personId!!)
            assertEquals(false, manager.client.view(world).can().getValue(bindingId), "a deleted person manages nothing")
            assertEquals(true, w.admin.client.view(world).can().getValue(bindingId), "ADMIN is unaffected")
            // The login is gone: its token is refused outright, and the route's resolver finds no managed team.
            TestUsers.softDelete(others.userId)
            assertEquals(
                HttpStatusCode.Unauthorized,
                others.client.get("/api/v1/views/capacity-deviations?connectionId=${mirror.connectionId}").status,
            )
            assertEquals(emptySet(), TeamService(sharedDatabaseForTests()).activeManagedTeamIds(others.userId))
        }
    }

    @Test
    fun `the cap counts only the teams that are listed - an acknowledged-only team takes no slot`() = testApplication {
        val world = dayTwo("capack-v7")
        with(world) {
            val admin = w.admin.client
            manager.client.capAck(bindingId, 2, admin.rowOf(2).fingerprint).capAcknowledgement()
            manager.client.capAck(bindingId, 3, admin.rowOf(3).fingerprint).capAcknowledgement()
            val db = sharedDatabaseForTests()
            val capped = CapacityDeviationService(
                db, mirror.harness.bindings, mirror.harness.mirror, TeamCapacityService(db), mirror.harness.runs, maxItems = 1,
            )
            fun filter(all: Boolean?) = CapacityDeviationFilter(connectionId = mirror.connectionId, all = all)

            val open = capped.view(filter(null))
            assertEquals(listOf(billingBindingId), open.items.map { it.bindingId }, "the acknowledged-only team is not listed")
            assertFalse(open.truncated, "one team is listed and the cap is one")
            assertEquals(1, open.totals.teams)

            val everything = capped.view(filter(true))
            assertEquals(listOf(billingBindingId), everything.items.map { it.bindingId }, "the open warning first, then the cap")
            assertTrue(everything.truncated)
            assertEquals(2, everything.totals.teams, "teams are counted before the cap")
            assertEquals(listOf(1, 0, 1, 2), everything.totals.let { listOf(it.warnings, it.infos, it.gone, it.acknowledged) })
        }
    }

    @Test
    fun `a malformed or repeated acknowledged or all is a 400`() = testApplication {
        val world = dayTwo("capack-v5")
        val client = world.w.admin.client
        val bad = listOf("acknowledged=maybe", "acknowledged=1", "all=yes", "all=true&all=false", "acknowledged=true&acknowledged=false")
        for (query in bad) {
            val response = client.get("/api/v1/views/capacity-deviations?$query")
            assertEquals(HttpStatusCode.BadRequest, response.status, query)
        }
        assertEquals(HttpStatusCode.OK, client.get("/api/v1/views/capacity-deviations?acknowledged=false&all=false").status)
    }

    @Test
    fun `the service's team read carries the rows with their state, the connection's enabled flag, and null for an unlinked team`() =
        testApplication {
            val world = dayTwo("capack-v6")
            with(world) {
                val service = CapacityDeviationService(
                    sharedDatabaseForTests(), mirror.harness.bindings, mirror.harness.mirror, TeamCapacityService(sharedDatabaseForTests()),
                    mirror.harness.runs,
                )
                val calendar = suspendTransaction(sharedDatabaseForTests()) { loadWorkingCalendar() }
                val db = sharedDatabaseForTests()
                suspend fun facts(team: UInt) = suspendTransaction(db) { service.computeTeamInTransaction(team, calendar) }

                manager.client.capAck(bindingId, 3, w.admin.client.rowOf(3).fingerprint).capAcknowledgement()
                val linked = assertNotNull(facts(teamId))
                assertTrue(linked.enabled)
                assertEquals(listOf(2L, 3L), linked.deviations.map { it.detail.sprintId })
                assertEquals(listOf(DeviationSeverity.WARNING, DeviationSeverity.INFO), linked.deviations.map { it.severity })
                assertEquals(listOf<Boolean?>(null, true), linked.deviations.map { it.acknowledgement?.current }, "every row, with state")
                assertEquals(
                    listOf(CapacityDeviationKind.TEAM_GONE),
                    assertNotNull(facts(w.requireTeams().otherTeamId)).deviations.map { it.kind },
                    "a gone team's one row",
                )

                jbSql("UPDATE flow_connections SET enabled = FALSE WHERE id = ?", mirror.connectionId.toInt())
                assertFalse(assertNotNull(facts(teamId)).enabled, "a disabled connection is reported, not hidden")

                val unlinked = TestTeams.seed(planName("capack-unlinked"))
                assertNull(facts(unlinked), "a team with no link has nothing to compare")
            }
        }
}
