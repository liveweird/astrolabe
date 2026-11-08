package ch.nokillswit

import ch.nokillswit.flow.FlowMirrorMember
import ch.nokillswit.flow.FlowMirrorSprint
import ch.nokillswit.flow.FlowRoster
import ch.nokillswit.flow.FlowSprintSummary
import ch.nokillswit.flow.FlowTeamService
import ch.nokillswit.flow.FlowRosterCurrent
import ch.nokillswit.flow.FlowRosterFormer
import ch.nokillswit.flow.RosterAudience
import ch.nokillswit.flow.UNKNOWN_ACCOUNT
import ch.nokillswit.flow.nextSprintStart
import ch.nokillswit.flow.rosterOf
import ch.nokillswit.flow.rosterVisibleTo
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.math.BigDecimal
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `GET /teams/{id}/flow`: the team page's Flow panel - unbound, bound and gone; the roster (current vs former, the half-open interval in
 * the connection's zone); `can` per caller; and Q2a pinned: every signed-in user sees the roster, nobody sees an account id, an email, a
 * token or a base URL.
 */
class FlowTeamPanelTest {
    private companion object {
        const val PREFIX = "flowpanel"
        const val DAY = 24L * 60 * 60 * 1000
        val WARSAW: ZoneId = ZoneId.of("Europe/Warsaw")
    }

    @AfterTest
    fun cleanUp() {
        removeFlowFixtureRows(PREFIX)
    }

    private fun panelPath(teamId: UInt) = "/api/v1/teams/$teamId/flow"

    private fun JsonObject.obj(key: String): JsonObject = getValue(key).jsonObject

    private fun JsonObject.text(key: String): String = getValue(key).jsonPrimitive.content

    private fun JsonObject.names(key: String, field: String) = obj("roster").getValue(key).jsonArray.map { it.jsonObject.text(field) }

    private fun instant(text: String) = Instant.parse(text).toEpochMilli()

    private fun date(instant: Long) = Instant.ofEpochMilli(instant).atZone(WARSAW).toLocalDate().toString()

    @Test
    fun `an unlinked team has a panel without binding, roster or sprints - and can is ADMIN or the team's manager`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbpanel0", teams = true)
        val teams = w.requireTeams()
        val allowed = listOf("admin" to w.admin, "manager" to teams.manager)
        val denied = listOf(
            "other team's manager" to teams.otherManager, "project owner" to w.projectOwner, "editor" to w.editor,
            "stranger" to w.stranger, "person-less login" to w.personless,
        )
        for ((who, caller) in allowed + denied) {
            val response = caller.client.get(panelPath(teams.teamId))
            assertEquals(HttpStatusCode.OK, response.status, who)
            val body = response.bodyAsText().fbObject()
            val can = body.obj("can")
            val expected = who in allowed.map { it.first }
            val flags = listOf("link", "unlink", "importCapacity").map { can.text(it).toBoolean() }
            assertEquals(listOf(expected, expected, expected), flags, who)
            assertEquals(teams.teamId.toString(), body.obj("team").text("id"))
            listOf("binding", "roster", "sprints").forEach { assertNull(body.fbNullable(it), "$who: $it") }
        }
    }

    @Test
    fun `a missing or deleted team is 404 for every caller`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbpanel404", teams = true)
        val gone = TestTeams.seed(planName("fb-gone"))
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/$gone").status)
        for (caller in listOf(w.admin, w.stranger, w.personless)) {
            assertEquals(HttpStatusCode.NotFound, caller.client.get(panelPath(999_999u)).status)
            assertEquals(HttpStatusCode.NotFound, caller.client.get(panelPath(gone)).status)
        }
    }

    @Test
    fun `a linked team shows its binding, status, sprints and roster - to every signed-in user, and nothing secret`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbpanel1", teams = true)
        val teams = w.requireTeams()
        val now = System.currentTimeMillis()
        val flowName = planName("fb-flow")
        val m = ScriptedFlowMirror(PREFIX).connect().refresh(
            flowTeamDoc(
                7, flowName,
                members = listOf(
                    flowMemberJson("acc-current", "Current One", now - 30 * DAY, null),
                    flowMemberJson("acc-unnamed", null, now - 5 * DAY, null),
                    flowMemberJson("acc-zone", "Zone Walker", instant("2026-03-10T23:30:00Z"), null),
                    flowMemberJson("acc-former", "Former One", now - 90 * DAY, now - 10 * DAY),
                    flowMemberJson("acc-fixed", "Fixed Former", instant("2025-06-30T22:30:00Z"), instant("2025-12-31T23:30:00Z")),
                    flowMemberJson("acc-future", "Not Yet", now + 10 * DAY, null),
                ),
                sprints = listOf(
                    flowSprintJson(1, now - 30 * DAY, now - 16 * DAY),
                    flowSprintJson(2, now + 5 * DAY, now + 19 * DAY),
                    flowSprintJson(3, now + 20 * DAY, now + 34 * DAY),
                    flowSprintJson(4, null, null),
                ),
            ),
        )
        val connectionName = checkNotNull(m.harness.connections.read(m.connectionId)).name
        val binding = w.admin.client.fbBind(m.connectionId, 7, teams.teamId).fbBinding()

        for (caller in listOf(w.admin, teams.manager, teams.otherManager, w.projectOwner, w.editor, w.stranger, w.personless)) {
            val response = caller.client.get(panelPath(teams.teamId))
            assertEquals(HttpStatusCode.OK, response.status)
            val text = response.bodyAsText()
            listOf("flow_int_", "flow.test", "acc-", "@", "apiToken", "baseUrl", "timeZone").forEach {
                assertFalse(it in text, "no '$it' in $text")
            }
            val body = text.fbObject()
            val linked = body.obj("binding")
            assertEquals(binding.id.toString(), linked.text("id"))
            val facts = listOf("connectionId", "connectionName", "flowTeamId", "flowTeamName").map { linked.text(it) }
            assertEquals(listOf(m.connectionId.toString(), connectionName, "7", flowName), facts)
            assertEquals(listOf("true", "false"), listOf("connectionEnabled", "gone").map { linked.text(it) })
            assertEquals("CURRENT", linked.obj("status").text("state"))
            assertNotNull(linked.fbNullable("observedAt"))
            // Q2a: the roster is for every signed-in user, not only the manager.
            assertEquals(listOf("Current One", UNKNOWN_ACCOUNT, "Zone Walker"), body.names("current", "displayName"))
            val former = body.names("former", "displayName")
            assertEquals(listOf("Former One", "Fixed Former"), former, "newest end first; a future membership is in neither list")
            assertEquals(listOf(date(now - 30 * DAY), date(now - 5 * DAY), "2026-03-11"), body.names("current", "since"))
            val fixed = body.obj("roster").getValue("former").jsonArray.map { it.jsonObject }.last()
            val fixedDates = listOf("from", "to").map { fixed.text(it) }
            assertEquals(listOf("2025-07-01", "2026-01-01"), fixedDates, "dates are in the connection's zone")
            val sprints = body.obj("sprints")
            assertEquals("4", sprints.text("count"))
            assertEquals(date(now + 5 * DAY), sprints.text("nextStart"))
        }
    }

    @Test
    fun `a linked Flow team that left the document is gone - and a disabled connection says so`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("fbpanel2", teams = true)
        val teams = w.requireTeams()
        val m = ScriptedFlowMirror(PREFIX).connect().refresh(flowTeamJson(1, planName("fb-a")), flowTeamJson(2, planName("fb-b")))
        w.admin.client.fbBind(m.connectionId, 2, teams.teamId).fbBinding()
        jbSql("UPDATE flow_connections SET enabled = FALSE WHERE id = ?", m.connectionId.toInt())

        val present = w.stranger.client.get(panelPath(teams.teamId)).bodyAsText().fbObject()
        assertEquals("false", present.obj("binding").text("connectionEnabled"))
        assertEquals("false", present.obj("binding").text("gone"))
        assertNotNull(present.fbNullable("roster"))

        jbSql("UPDATE flow_connections SET enabled = TRUE WHERE id = ?", m.connectionId.toInt())
        m.refresh(flowTeamJson(1, planName("fb-a"))) // Flow no longer lists team 2
        val teamsAt = checkNotNull(m.harness.connections.read(m.connectionId)?.teamsAt)
        val gone = w.stranger.client.get(panelPath(teams.teamId)).bodyAsText().fbObject()
        assertEquals("true", gone.obj("binding").text("gone"))
        assertEquals(teamsAt.toString(), gone.obj("binding").text("observedAt"), "the age of the document that no longer has it")
        assertNull(gone.fbNullable("roster"))
        assertNull(gone.fbNullable("sprints"))
        assertEquals(1, fbActiveCount(m.connectionId))
    }

    @Test
    fun `with an injected clock the panel pins the interval boundaries and the next sprint`() = runBlocking {
        val now = Instant.parse("2026-06-15T12:00:00Z").toEpochMilli()
        val m = ScriptedFlowMirror(PREFIX).connect().refresh(
            flowTeamDoc(
                3, planName("fb-clock"),
                members = listOf(
                    flowMemberJson("acc-1", "Ends now", now - DAY, now), // validTo == now: former
                    flowMemberJson("acc-2", "Starts now", now, null), // validFrom == now: current
                    flowMemberJson("acc-3", "Not yet", now + 1, null), // in neither list
                ),
                sprints = listOf(
                    flowSprintJson(1, instant("2026-06-14T10:00:00Z"), null), // yesterday in Warsaw
                    flowSprintJson(2, instant("2026-06-14T22:00:00Z"), null), // 00:00 on the 15th in Warsaw: today counts
                    flowSprintJson(3, instant("2026-06-30T07:00:00Z"), null),
                ),
            ),
        )
        try {
            val team = m.harness.bind("fbpanel-clock", m.connectionId, 3)
            val service = FlowTeamService(sharedDatabaseForTests(), m.harness.connections, m.harness.mirror) { now }
            val panel = checkNotNull(service.panel(team, manages = false))
            assertEquals(listOf(FlowRosterCurrent("Starts now", "2026-06-15")), checkNotNull(panel.roster).current)
            assertEquals(listOf(FlowRosterFormer("Ends now", "2026-06-14", "2026-06-15")), panel.roster?.former)
            assertEquals(FlowSprintSummary(3, "2026-06-15"), panel.sprints)
            assertFalse(panel.can.link)
            assertTrue(checkNotNull(service.panel(team, manages = true)).can.importCapacity)
        } finally {
            m.cleanUp()
        }
    }

    @Test
    fun `the roster intervals are half-open and dated in the connection's zone`() {
        val now = Instant.parse("2026-06-15T12:00:00Z").toEpochMilli()

        fun member(name: String?, from: Long, to: Long?) = FlowMirrorMember("acc-$from", name, from, to)
        val roster = rosterOf(
            listOf(
                member("Ends now", now - DAY, now), // validTo == now: already former
                member("Starts now", now, null), // validFrom == now: already current
                member("Starts next ms", now + 1, null), // not yet a member: in neither list
                member("Open", now - 2 * DAY, null),
                member(null, now - 3 * DAY, now + DAY), // current until tomorrow; no name
                member("  ", now - 4 * DAY, null), // a blank name reads as unknown too
            ),
            WARSAW, now,
        )
        assertEquals(
            FlowRoster(
                current = listOf(
                    FlowRosterCurrent("Open", "2026-06-13"),
                    FlowRosterCurrent("Starts now", "2026-06-15"),
                    FlowRosterCurrent(UNKNOWN_ACCOUNT, "2026-06-11"),
                    FlowRosterCurrent(UNKNOWN_ACCOUNT, "2026-06-12"),
                ),
                former = listOf(FlowRosterFormer("Ends now", "2026-06-14", "2026-06-15")),
            ),
            roster,
        )
        // The zone moves the date: 23:30 UTC on the 14th is already the 15th in Warsaw (UTC+2), still the 14th in New York.
        val late = member("Night owl", Instant.parse("2026-06-14T23:30:00Z").toEpochMilli(), null)
        assertEquals("2026-06-15", rosterOf(listOf(late), WARSAW, now).current.single().since)
        assertEquals("2026-06-14", rosterOf(listOf(late), ZoneId.of("America/New_York"), now).current.single().since)
    }

    @Test
    fun `the next sprint is the first start that is today or later in the zone`() {
        fun sprint(start: Long?) = FlowMirrorSprint(1, 1, "S", "future", start, null, null, true, BigDecimal.TEN, null)

        val today = LocalDate.parse("2026-06-15")
        val atZone = { date: String, hour: Int -> LocalDate.parse(date).atTime(hour, 0).atZone(WARSAW).toInstant().toEpochMilli() }
        val sprints = listOf(
            sprint(atZone("2026-06-14", 23)), sprint(atZone("2026-06-15", 0)), sprint(atZone("2026-07-01", 9)), sprint(null),
        )
        assertEquals(LocalDate.parse("2026-06-15"), nextSprintStart(sprints, WARSAW, today), "today counts")
        assertEquals(LocalDate.parse("2026-07-01"), nextSprintStart(sprints.drop(2), WARSAW, today))
        assertNull(nextSprintStart(sprints.take(1) + sprint(null), WARSAW, today))
    }

    @Test
    fun `the roster audience is one predicate - every login today, the manager and ADMIN only after the one-line flip`() {
        assertTrue(rosterVisibleTo(RosterAudience.EVERY_LOGIN, manages = false))
        assertTrue(rosterVisibleTo(RosterAudience.EVERY_LOGIN, manages = true))
        assertFalse(rosterVisibleTo(RosterAudience.MANAGER_OR_ADMIN, manages = false))
        assertTrue(rosterVisibleTo(RosterAudience.MANAGER_OR_ADMIN, manages = true))
    }
}
