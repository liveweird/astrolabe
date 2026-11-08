package ch.nokillswit

import ch.nokillswit.flow.CapacityImportService
import ch.nokillswit.flow.FlowClientFactory
import ch.nokillswit.flow.HttpFlowClient
import ch.nokillswit.flow.buildGuardedFlowHttpClient
import ch.nokillswit.flow.createFlowHttp
import ch.nokillswit.infra.outbound.FlowOrigins
import ch.nokillswit.infra.outbound.Origin
import ch.nokillswit.infra.outbound.SelfManagedHosts
import ch.nokillswit.sync.SyncOutcome
import ch.nokillswit.teams.TeamCapacityService
import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.AfterClass
import org.junit.BeforeClass
import java.math.BigDecimal
import java.net.URI
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * `POST /integrations/flow/team-bindings/{id}/capacity-preview`: the stub's E2E Flow Team against `sample-data/flow/expected.json`
 * (six 2047 sprints), every action and skip reason through the route over a scripted Flow document and seeded periods, the caller matrix
 * and the 404 -> 403 -> 400 order, an absent Flow team, the connection zone's "today", and that a preview writes and audits nothing.
 */
class CapacityImportPreviewTest {
    private companion object {
        const val PREFIX = "capprev"
        val WARSAW: ZoneId = ZoneId.of("Europe/Warsaw")

        private val guarded by lazy {
            val origins = FlowOrigins(SelfManagedHosts.NONE, setOf(Origin("http", "localhost", URI(FlowStubServer.baseUrl).port)), true)
            buildGuardedFlowHttpClient(origins, requestTimeoutSeconds = 30)
        }

        @JvmStatic
        @BeforeClass
        fun warmStub() {
            FlowStubFixture.warm()
        }

        @JvmStatic
        @AfterClass
        fun closeClient() {
            guarded.close()
        }
    }

    private val stubHarness = FlowRunHarness(
        FlowClientFactory { baseUrl, token -> HttpFlowClient(createFlowHttp(guarded, 0, 4L * 1024 * 1024, 1), baseUrl, token) },
    )
    private val mirrors = mutableListOf<ScriptedFlowMirror>()

    @AfterTest
    fun cleanUp() {
        stubHarness.cleanUp(PREFIX)
        mirrors.forEach { it.cleanUp() }
        mirrors.clear()
        removeFlowFixtureRows(PREFIX)
    }

    private fun at(date: String, time: String = "09:00", zone: ZoneId = WARSAW): Long =
        LocalDateTime.parse("${date}T$time").atZone(zone).toInstant().toEpochMilli()

    private fun sprintJson(id: Long, name: String, startAt: Long?, endAt: Long?, md: String?): String {
        val source = md?.let { "\"CALENDAR\"" } ?: "null"
        return """{"sprintId":$id,"connectionId":3,"name":"$name","state":"future","startAt":${startAt ?: "null"},""" +
            """"endAt":${endAt ?: "null"},"completeAt":null,"hasCalendar":true,"capacityMd":${md ?: "null"},"capacitySource":$source}"""
    }

    /** A mirror of one Flow team (id 1) with [sprints], connected in [zone]. */
    private suspend fun mirrorOf(flowName: String, sprints: List<String>, zone: String = "Europe/Warsaw"): ScriptedFlowMirror =
        ScriptedFlowMirror(PREFIX).connect(zone).refresh(flowTeamDoc(1, flowName, sprints = sprints)).also { mirrors += it }

    private suspend fun HttpClient.preview(bindingId: UInt, body: String = "{}"): HttpResponse =
        post("$FB_BINDINGS/$bindingId/capacity-preview") {
            contentType(ContentType.Application.Json)
            setBody(body)
        }

    private fun JsonObject.items() = getValue("items").jsonArray.map { it.jsonObject }

    private fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.content

    private fun JsonObject.number(key: String) = BigDecimal(text(key))

    private fun seedFlowPeriod(teamId: UInt, from: String, md: String, sprintId: Long, name: String, wip: Int? = null) = jbSql(
        "INSERT INTO team_capacity_periods (team_id, effective_from, md_per_week, wip_limit, source, flow_sprint_id, flow_sprint_name, " +
            "created_at, updated_at) VALUES (?, ?::date, ?::numeric, ${wip ?: "NULL"}, 'FLOW', ?, ?, 1, 1)",
        teamId.toInt(), from, md, sprintId, name,
    )

    @Test
    fun `the stub's E2E Flow Team previews the six 2047 sprints of expected json - 20, 18, 22, 20, 19, 21 MD a week`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("cipstub", teams = true)
        val teams = w.requireTeams()
        val e2e = FlowStubServer.expected.getValue("e2e").jsonObject
        val connectionId = stubHarness.connect(PREFIX, FlowStubServer.baseUrl, FlowStubServer.token)
        assertEquals(SyncOutcome.SUCCEEDED, stubHarness.run(connectionId).outcome)
        val flowTeamId = stubHarness.mirror.teamsOf(connectionId).single { it.name == e2e.text("team") }.flowTeamId
        val binding = w.admin.client.fbBind(connectionId, flowTeamId, teams.teamId).fbBinding()

        val response = teams.manager.client.preview(binding.id)

        assertEquals(HttpStatusCode.OK, response.status)
        val body = response.bodyAsText().fbObject()
        assertEquals(binding.id.toString(), body.text("bindingId"))
        assertEquals(teams.teamId.toString(), body.text("teamId"))
        assertEquals("Europe/Warsaw", body.text("zone"))
        assertEquals("false", body.text("includeClosed"))
        assertTrue(Regex("""\d{4}-\d{2}-\d{2}""").matches(body.text("from")), "the resolved from: today in the zone")
        assertNotNull(body.fbNullable("observedAt"))
        val expected = e2e.getValue("preview").jsonArray.map { it.jsonObject }
        assertEquals(6, expected.size)
        val items = body.items()
        assertEquals(expected.size, items.size)
        expected.zip(items).forEach { (want, got) ->
            val label = want.text("name")
            assertEquals(want.text("sprintId"), got.text("sprintId"), label)
            assertEquals(label, got.text("name"))
            assertEquals(want.text("start"), got.text("start"), label)
            assertEquals(want.text("end"), got.text("end"), label)
            assertEquals(want.text("start"), got.text("effectiveFrom"), label)
            assertEquals(want.text("workingDays"), got.text("workingDays"), label)
            assertEquals(0, want.number("flowMd").compareTo(got.number("flowMd")), label)
            assertEquals(0, want.number("mdPerWeek").compareTo(got.number("mdPerWeek")), "$label: ${got.text("mdPerWeek")}")
            assertEquals("CREATE", got.text("action"), label)
            assertEquals("true", got.text("ticked"), label)
            assertNull(got.fbNullable("existing"), label)
            assertNull(got.fbNullable("reason"), label)
            assertEquals(0, got.getValue("infos").jsonArray.size, label)
        }
        val totals = body.getValue("totals").jsonObject
        assertEquals(listOf("6", "0", "0", "0", "0"), listOf("create", "update", "unchanged", "skip", "removals").map { totals.text(it) })
        assertEquals(0, body.getValue("removals").jsonArray.size)
    }

    @Test
    fun `every action and skip reason through the route - and the closed toggle and from`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("cipactions", teams = true)
        val teams = w.requireTeams()
        val m = mirrorOf(
            planName("cip-flow"),
            listOf(
                sprintJson(10, "Closed 2020", at("2020-03-02"), at("2020-03-13", "17:00"), "20"),
                sprintJson(1, "Manual start", at("2049-03-01"), at("2049-03-12", "17:00"), "40"),
                sprintJson(2, "Updated", at("2049-03-15"), at("2049-03-26", "17:00"), "36"),
                sprintJson(3, "Same", at("2049-03-29"), at("2049-04-09", "17:00"), "44"),
                sprintJson(4, "No capacity", at("2049-04-12"), at("2049-04-23", "17:00"), null),
                sprintJson(5, "Manual inside", at("2049-04-26"), at("2049-05-07", "17:00"), "30"),
                sprintJson(6, "No dates", null, null, "10"),
                // Wholly inside "Manual inside" (Flow counts no day for it): the only OVERLAPS.
                sprintJson(7, "Overlaps", at("2049-05-04"), at("2049-05-06", "17:00"), "10"),
            ),
        )
        val binding = w.admin.client.fbBind(m.connectionId, 1, teams.teamId).fbBinding()
        val manual = TestPlan.capacityPeriod(teams.teamId, "2049-03-01", 50.0)
        TestPlan.capacityPeriod(teams.teamId, "2049-05-03", 12.0)
        seedFlowPeriod(teams.teamId, "2049-03-15", "15.00", 2, "Updated", wip = 4)
        seedFlowPeriod(teams.teamId, "2049-03-29", "22.00", 3, "Same")
        seedFlowPeriod(teams.teamId, "2049-07-05", "9.00", 99, "Gone sprint")
        val client = teams.manager.client

        val body = client.preview(binding.id).bodyAsText().fbObject()

        val byName = body.items().associateBy { it.text("name") }
        assertEquals(
            listOf("Manual start", "Updated", "Same", "No capacity", "Manual inside", "Overlaps", "No dates"),
            body.items().map { it.text("name") },
            "the closed 2020 sprint is left out; undated last",
        )
        fun action(name: String): String {
            val item = byName.getValue(name)
            return item.text("action") + (item.fbNullable("reason")?.jsonPrimitive?.content?.let { ":$it" } ?: "")
        }
        assertEquals("MANUAL_PERIOD", action("Manual start"))
        assertEquals("UPDATE", action("Updated"))
        assertEquals("UNCHANGED", action("Same"))
        assertEquals("SKIP:NO_CAPACITY", action("No capacity"))
        assertEquals("CREATE", action("Manual inside"))
        assertEquals("SKIP:OVERLAPS", action("Overlaps"))
        assertEquals("SKIP:NO_DATES", action("No dates"))
        val updated = byName.getValue("Updated")
        assertEquals(0, BigDecimal("18").compareTo(updated.number("mdPerWeek")))
        assertEquals(0, BigDecimal("15").compareTo(updated.getValue("existing").jsonObject.number("mdPerWeek")))
        assertEquals("FLOW", updated.getValue("existing").jsonObject.text("source"))
        assertEquals(manual.toString(), byName.getValue("Manual start").getValue("existing").jsonObject.text("periodId"))
        val infos = byName.getValue("Manual inside").getValue("infos").jsonArray.map { it.jsonObject }
        assertEquals(listOf("MANUAL_PERIOD_INSIDE" to "2049-05-03"), infos.map { it.text("code") to it.text("date") })
        val ticked = listOf("Manual start", "Updated", "Same", "No capacity", "Manual inside").map { byName.getValue(it).text("ticked") }
        assertEquals(listOf("false", "true", "false", "false", "true"), ticked)
        val totals = body.getValue("totals").jsonObject
        assertEquals(listOf("1", "1", "1", "4", "1"), listOf("create", "update", "unchanged", "skip", "removals").map { totals.text(it) })
        val removal = body.getValue("removals").jsonArray.single().jsonObject
        assertEquals("2049-07-05", removal.text("effectiveFrom"))
        assertEquals("Gone sprint", removal.text("flowSprintName"))
        assertEquals("99", removal.text("flowSprintId"))

        val withClosed = client.preview(binding.id, """{"includeClosed":true}""").bodyAsText().fbObject().items()
        assertEquals("Closed 2020", withClosed.first().text("name"))
        assertEquals("false", withClosed.first().text("ticked"))
        assertEquals("CREATE", withClosed.first().text("action"))
        assertEquals(8, withClosed.size)

        val laterBody = client.preview(binding.id, """{"from":"2049-03-20","includeClosed":true}""").bodyAsText().fbObject()
        assertEquals("2049-03-20", laterBody.text("from"), "the resolved from is echoed for the apply")
        assertEquals("true", laterBody.text("includeClosed"))
        val later = client.preview(binding.id, """{"from":"2049-03-20"}""").bodyAsText().fbObject().items().map { it.text("name") }
        assertEquals(
            listOf("Updated", "Same", "No capacity", "Manual inside", "Overlaps", "No dates"), later,
            "Manual start ended 03-12: closed",
        )
    }

    @Test
    fun `ADMIN and the team's manager preview - every other caller is 403, even with a body that does not decode`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("cipmatrix", teams = true)
        val teams = w.requireTeams()
        val m = mirrorOf(planName("cip-flow"), listOf(sprintJson(1, "S1", at("2049-03-01"), at("2049-03-12", "17:00"), "40")))
        val binding = w.admin.client.fbBind(m.connectionId, 1, teams.teamId).fbBinding()
        val outsiders = listOf(
            "other team's manager" to teams.otherManager, "project owner" to w.projectOwner, "program owner" to w.programOwner,
            "stream owner" to w.streamOwner, "editor" to w.editor, "stranger" to w.stranger, "person-less login" to w.personless,
        )
        for ((who, caller) in outsiders) {
            assertEquals(HttpStatusCode.Forbidden, caller.client.preview(binding.id).status, who)
            assertEquals(HttpStatusCode.Forbidden, caller.client.preview(binding.id, "{ not json").status, "$who: 403 beats the 400")
        }
        for ((who, caller) in listOf("admin" to w.admin, "manager" to teams.manager)) {
            val response = caller.client.preview(binding.id)
            assertEquals(HttpStatusCode.OK, response.status, who)
            assertEquals(1, response.bodyAsText().fbObject().items().size, who)
        }
    }

    @Test
    fun `the order is binding 404 for every caller, then guard 403, then body 400`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("cipsorder", teams = true)
        val teams = w.requireTeams()
        val m = mirrorOf(planName("cip-flow"), listOf(sprintJson(1, "S1", at("2049-03-01"), at("2049-03-12", "17:00"), "40")))
        val binding = w.admin.client.fbBind(m.connectionId, 1, teams.teamId).fbBinding()
        val everyone = listOf("admin" to w.admin, "manager" to teams.manager, "stranger" to w.stranger, "person-less login" to w.personless)

        // 400s (past the guard): an undecodable body, a bad or out-of-range `from`, a wrongly typed toggle, an empty body.
        val badBodies = listOf(
            "{ not json", """{"from":"tomorrow"}""", """{"from":"2049-02-30"}""", """{"from":"1800-01-01"}""", """{"from":20490301}""",
            """{"includeClosed":"yes"}""", "",
        )
        for ((who, caller) in listOf("admin" to w.admin, "manager" to teams.manager)) {
            for (body in badBodies) {
                assertEquals(HttpStatusCode.BadRequest, caller.client.preview(binding.id, body).status, "$who: <$body>")
            }
        }
        // 404: an unknown id, an unlinked binding, a binding whose team was deleted - for EVERY caller, with any body.
        val other = w.admin.client.fbBind(mirrorOf(planName("cip-two"), emptyList()).connectionId, 1, teams.otherTeamId).fbBinding()
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/${teams.otherTeamId}").status)
        for ((who, caller) in everyone) {
            assertEquals(HttpStatusCode.NotFound, caller.client.preview(999_999u).status, "$who: unknown")
            assertEquals(HttpStatusCode.NotFound, caller.client.preview(999_999u, "{ not json").status, "$who: 404 beats the 400")
            assertEquals(HttpStatusCode.NotFound, caller.client.preview(other.id).status, "$who: the team is deleted")
        }
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("$FB_BINDINGS/${binding.id}").status)
        for ((who, caller) in everyone) {
            assertEquals(HttpStatusCode.NotFound, caller.client.preview(binding.id).status, "$who: unlinked")
            assertEquals(HttpStatusCode.NotFound, caller.client.preview(binding.id, "{ not json").status, "$who: unlinked, bad body")
        }
    }

    @Test
    fun `a Flow team that left the mirror previews an empty plan - nothing is removed on the strength of an absence`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("cipgone", teams = true)
        val teams = w.requireTeams()
        val m = mirrorOf(planName("cip-flow"), listOf(sprintJson(1, "S1", at("2049-03-01"), at("2049-03-12", "17:00"), "40")))
        val binding = w.admin.client.fbBind(m.connectionId, 1, teams.teamId).fbBinding()
        seedFlowPeriod(teams.teamId, "2049-03-01", "20.00", 1, "S1")
        // The next document no longer has team 1.
        m.refresh(flowTeamDoc(2, planName("cip-other")))

        val body = teams.manager.client.preview(binding.id).bodyAsText().fbObject()

        assertNull(body.fbNullable("observedAt"))
        assertEquals(0, body.items().size)
        assertEquals(0, body.getValue("removals").jsonArray.size)
        assertEquals("Europe/Warsaw", body.text("zone"))
    }

    @Test
    fun `a preview stores nothing and audits nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("cipread", teams = true)
        val teams = w.requireTeams()
        val m = mirrorOf(planName("cip-flow"), listOf(sprintJson(1, "S1", at("2049-03-01"), at("2049-03-12", "17:00"), "40")))
        val binding = w.admin.client.fbBind(m.connectionId, 1, teams.teamId).fbBinding()
        seedFlowPeriod(teams.teamId, "2049-03-08", "9.00", 77, "Stale")
        fun periods() = jbScalar(
            "SELECT count(*) FROM team_capacity_periods WHERE team_id = ? AND NOT marked_as_deleted", teams.teamId.toInt(),
        ) { it.getInt(1) }
        val before = periods()

        withAuditCapture { audit ->
            val response = teams.manager.client.preview(binding.id)
            assertEquals(HttpStatusCode.OK, response.status)
            assertEquals(1, response.bodyAsText().fbObject().getValue("removals").jsonArray.size, "the plan wants the stale period gone")
            val audited = audit.events.filter { it.message.startsWith("team.capacity") || it.message.startsWith("flow.") }
            assertTrue(audited.isEmpty(), "a preview is not audited")
        }

        assertEquals(before, periods())
        assertEquals(
            "FLOW",
            jbScalar(
                "SELECT source FROM team_capacity_periods WHERE team_id = ? AND flow_sprint_id = 77", teams.teamId.toInt(),
            ) { it.getString(1) },
        )
    }

    @Test
    fun `a public holiday inside a sprint end to end - nine working days, 22 22 a week`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("cipholiday", teams = true)
        val teams = w.requireTeams()
        val m = mirrorOf(planName("cip-flow"), listOf(sprintJson(1, "Holiday", at("2049-09-06"), at("2049-09-17", "17:00"), "40")))
        val binding = w.admin.client.fbBind(m.connectionId, 1, teams.teamId).fbBinding()

        val plain = teams.manager.client.preview(binding.id).bodyAsText().fbObject().items().single()
        assertEquals(listOf("10", "20.0"), listOf(plain.text("workingDays"), plain.text("mdPerWeek")))

        val item = TestHolidays.with("2049-09-08") {
            teams.manager.client.preview(binding.id).bodyAsText().fbObject().items().single()
        }

        assertEquals("9", item.text("workingDays"))
        assertEquals(0, BigDecimal("22.22").compareTo(item.number("mdPerWeek")), item.text("mdPerWeek"))
        assertEquals("2049-09-06", item.text("effectiveFrom"))
    }

    @Test
    fun `a disabled connection still previews from its mirror - and a never-mirrored team has no observedAt`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("cipdisabled", teams = true)
        val teams = w.requireTeams()
        val m = mirrorOf(planName("cip-flow"), listOf(sprintJson(1, "S1", at("2049-03-01"), at("2049-03-12", "17:00"), "40")))
        val binding = w.admin.client.fbBind(m.connectionId, 1, teams.teamId).fbBinding()
        jbSql("UPDATE flow_connections SET enabled = FALSE WHERE id = ?", m.connectionId.toInt())

        val disabled = teams.manager.client.preview(binding.id)

        assertEquals(HttpStatusCode.OK, disabled.status)
        val body = disabled.bodyAsText().fbObject()
        assertEquals(1, body.items().size)
        assertNotNull(body.fbNullable("observedAt"))

        // A connection that never ran has no mirror at all: an empty plan, no observedAt.
        val fresh = ScriptedFlowMirror(PREFIX).connect().also { mirrors += it }
        val teamId = fresh.harness.bind(PREFIX, fresh.connectionId, 1, "FT")
        val bindingId = fresh.harness.bindings.bindingsOf(fresh.connectionId).single().id
        val empty = w.admin.client.preview(bindingId).bodyAsText().fbObject()
        assertEquals(teamId.toString(), empty.text("teamId"))
        assertNull(empty.fbNullable("observedAt"))
        assertEquals(0, empty.items().size)
    }

    @Test
    fun `from defaults to today in the CONNECTION's zone - the same instant is a different day in Auckland`() = runBlocking {
        // 2049-03-12T20:30Z is 21:30 on 03-12 in Warsaw and 09:30 on 03-13 in Auckland (NZDT, +13). The sprint ends 03-12 in both zones.
        val now = Instant.parse("2049-03-12T20:30:00Z").toEpochMilli()
        val database = sharedDatabaseForTests()
        val utc = ZoneId.of("UTC")
        suspend fun names(zone: String, from: java.time.LocalDate? = null): List<String> {
            val m = mirrorOf(
                planName("cip-zone"),
                listOf(sprintJson(1, "Zoned", at("2049-03-01", "08:00", utc), at("2049-03-12", "08:00", utc), "40")),
                zone,
            )
            m.harness.bind(PREFIX, m.connectionId, 1, "FT")
            val bindingId = m.harness.bindings.bindingsOf(m.connectionId).single().id
            val service = CapacityImportService(database, m.harness.bindings, m.harness.mirror, TeamCapacityService(database)) { now }
            return checkNotNull(service.preview(bindingId, from, includeClosed = false)).items.map { it.name }
        }

        assertEquals(listOf("Zoned"), names("Europe/Warsaw"), "03-12 is today in Warsaw: the sprint ends today, still open")
        assertEquals(emptyList(), names("Pacific/Auckland"), "03-13 is today in Auckland: the sprint ended yesterday, closed")
        assertEquals(listOf("Zoned"), names("Pacific/Auckland", from = java.time.LocalDate.of(2049, 3, 12)), "an explicit from wins")
    }
}
