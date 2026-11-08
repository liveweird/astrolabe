package ch.nokillswit

import ch.nokillswit.teams.CapacityImportCreate
import ch.nokillswit.teams.CapacityImportUpdate
import ch.nokillswit.teams.CapacityImportWrites
import ch.nokillswit.teams.CapacityPeriodRequest
import ch.nokillswit.teams.TeamCapacityService
import io.ktor.client.request.delete
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import java.math.BigDecimal
import java.time.LocalDate
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * `POST /integrations/flow/team-bindings/{id}/capacity-import` (the apply) over a scripted Flow document: creates, updates and removals in
 * one transaction with their audits, a re-import that writes nothing, a MANUAL period that no request can reach, the `CHANGED` skips
 * (a stale `expected`, a period taken over between the preview and the apply), the caller matrix and the 404 -> 403 -> 400 order, and the
 * service's own guard rails. The lock races are `CapacityImportApplyRaceTest`'s.
 */
class CapacityImportApplyTest {
    private companion object {
        const val PREFIX = "capapply"
        const val FAR_FROM = "2049-01-01"
    }

    private val mirrors = mutableListOf<ScriptedFlowMirror>()

    @AfterTest
    fun cleanUp() {
        mirrors.forEach { it.cleanUp() }
        mirrors.clear()
        removeFlowFixtureRows(PREFIX)
    }

    private suspend fun mirrorOf(flowName: String, sprints: List<String>): ScriptedFlowMirror =
        ScriptedFlowMirror(PREFIX).connect().refresh(flowTeamDoc(1, flowName, sprints = sprints)).also { mirrors += it }

    /** Three consecutive 2049 sprints of 20, 18 and 22 MD a week. */
    private fun threeSprints() = listOf(
        ciSprint(1, "S1", "2049-03-01", "2049-03-12", "40"),
        ciSprint(2, "S2", "2049-03-15", "2049-03-26", "36"),
        ciSprint(3, "S3", "2049-03-29", "2049-04-09", "44"),
    )

    private fun keyValues(event: ch.qos.logback.classic.spi.ILoggingEvent, vararg expected: Pair<String, Any>) {
        for ((key, value) in expected) assertTrue(event.hasKeyValue(key, value), "$key=$value in ${event.keyValuePairs}")
    }

    private fun periodPath(id: UInt) = "/api/v1/capacity-periods/$id"

    private fun JsonObject.ids(key: String) = getValue(key).jsonArray.map { it.jsonPrimitive.content.toUInt() }

    @Test
    fun `a CREATE, an UPDATE and a removal are applied in one go - the stored rows, the response and every audit`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capa1", teams = true)
        val t = w.requireTeams()
        val m = mirrorOf(planName("capa-flow"), threeSprints())
        val binding = w.admin.client.fbBind(m.connectionId, 1, t.teamId).fbBinding()
        val updating = ciSeedFlowPeriod(t.teamId, "2049-03-15", "15.00", 2, "S2 old", wip = 4)
        val unchanged = ciSeedFlowPeriod(t.teamId, "2049-03-29", "22.00", 3, "S3")
        val gone = ciSeedFlowPeriod(t.teamId, "2049-07-05", "9.00", 99, "Gone sprint")
        val client = t.manager.client
        val preview = client.ciPreviewOf(binding.id)
        assertEquals(listOf("CREATE", "UPDATE", "UNCHANGED"), preview.ciRows("items").map { it.ciText("action") })
        val before = ciTeamRows(t.teamId)

        withAuditCapture { audit ->
            val response = client.ciApply(binding.id, ciBodyOf(preview, removals = listOf(gone)))

            assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
            val body = response.bodyAsText().fbObject()
            val created = body.ciRows("created").single()
            assertEquals("1", created.ciText("sprintId"))
            val createdId = created.ciText("periodId").toUInt()
            assertEquals(listOf("2" to updating.toString()), body.ciRows("updated").map { it.ciText("sprintId") to it.ciText("periodId") })
            assertEquals(listOf(gone), body.ids("deleted"))
            assertEquals(0, body.getValue("skipped").jsonArray.size)

            assertEquals("2049-03-01|20.00|-|FLOW|1|S1|false", ciRowShape(createdId), "a new FLOW period: no WIP limit")
            assertEquals("2049-03-15|18.00|4|FLOW|2|S2|false", ciRowShape(updating), "figure, sprint and name rewritten; WIP limit kept")
            assertTrue(ciRow(updating).substringAfterLast('|').toLong() > 1, "updated_at moved")
            assertTrue(ciRowShape(gone).endsWith("|true"), "a removal is a soft delete")
            val untouched = before.single { it.startsWith("$unchanged=") }.substringAfter('=')
            assertEquals(ciRow(unchanged), untouched, "the UNCHANGED row is not touched")

            fun events(name: String) = audit.events.filter { it.message == name }
            val byUserId = t.manager.userId.toLong()
            keyValues(
                events("team.capacity_period_created").single(),
                "periodId" to createdId.toLong(), "byUserId" to byUserId, "teamId" to t.teamId.toLong(), "effectiveFrom" to "2049-03-01",
                "mdPerWeek" to 20.0, "wipLimit" to "none", "sourceTo" to "FLOW",
            )
            keyValues(
                events("team.capacity_period_updated").single(),
                "periodId" to updating.toLong(), "mdPerWeekFrom" to 15.0, "mdPerWeekTo" to 18.0, "wipLimitFrom" to 4, "wipLimitTo" to 4,
                "effectiveFromTo" to "2049-03-15", "sourceFrom" to "FLOW", "sourceTo" to "FLOW", "flowSprintIdFrom" to 2L,
                "flowSprintIdTo" to 2L, "flowSprintNameFrom" to "S2 old", "flowSprintNameTo" to "S2",
            )
            keyValues(events("team.capacity_period_deleted").single(), "periodId" to gone.toLong(), "sourceFrom" to "FLOW")
            keyValues(
                events("team.capacity_imported").single(),
                "byUserId" to byUserId, "teamId" to t.teamId.toLong(), "bindingId" to binding.id.toLong(),
                "connectionId" to m.connectionId.toLong(), "createdIds" to createdId.toString(), "updatedIds" to updating.toString(),
                "deletedIds" to gone.toString(), "skippedCount" to 0,
            )
        }
    }

    @Test
    fun `a re-import right after is all UNCHANGED and writes nothing - the old request is skipped CHANGED`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capa2", teams = true)
        val t = w.requireTeams()
        val m = mirrorOf(planName("capa-flow"), threeSprints())
        val binding = w.admin.client.fbBind(m.connectionId, 1, t.teamId).fbBinding()
        ciSeedFlowPeriod(t.teamId, "2049-03-15", "15.00", 2, "S2 old")
        val gone = ciSeedFlowPeriod(t.teamId, "2049-07-05", "9.00", 99, "Gone sprint")
        val client = t.manager.client
        val first = ciBodyOf(client.ciPreviewOf(binding.id), removals = listOf(gone))
        assertEquals(HttpStatusCode.OK, client.ciApply(binding.id, first).status)

        val again = client.ciPreviewOf(binding.id)
        val totals = again.getValue("totals").let { it as JsonObject }
        assertEquals(listOf("0", "0", "3", "0", "0"), listOf("create", "update", "unchanged", "skip", "removals").map { totals.ciText(it) })
        val settled = ciTeamRows(t.teamId)
        val replay = client.ciApply(binding.id, ciBodyOf(again)).bodyAsText().fbObject()
        assertEquals(listOf(0, 0, 0, 0), listOf("created", "updated", "deleted", "skipped").map { replay.getValue(it).jsonArray.size })
        assertEquals(settled, ciTeamRows(t.teamId), "an empty apply writes nothing - not even an updated_at")

        // The first request, sent again: every row is now UNCHANGED or gone - each is skipped CHANGED and nothing moves.
        val stale = client.ciApply(binding.id, first).bodyAsText().fbObject()
        assertEquals(listOf(0, 0, 0), listOf("created", "updated", "deleted").map { stale.getValue(it).jsonArray.size })
        val skipped = stale.ciRows("skipped")
        assertEquals(setOf("1", "2", "3"), skipped.mapNotNull { it["sprintId"]?.jsonPrimitive?.contentOrNull }.toSet())
        assertEquals(listOf(gone.toString()), skipped.mapNotNull { it["periodId"]?.jsonPrimitive?.contentOrNull })
        assertTrue(skipped.all { it.ciText("reason") == "CHANGED" })
        assertEquals(settled, ciTeamRows(t.teamId))
    }

    @Test
    fun `a MANUAL period is never written by any path - not as an item of either action, not as a removal, not beside a legitimate row`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("capa3", teams = true)
            val t = w.requireTeams()
            val m = mirrorOf(
                planName("capa-flow"),
                listOf(
                    ciSprint(1, "Manual start", "2049-03-01", "2049-03-12", "40"),
                    ciSprint(2, "Manual inside", "2049-03-15", "2049-03-26", "36"),
                    ciSprint(3, "Flow later", "2049-03-29", "2049-04-09", "44"),
                ),
            )
            val binding = w.admin.client.fbBind(m.connectionId, 1, t.teamId).fbBinding()
            val manualStart = TestPlan.capacityPeriod(t.teamId, "2049-03-01", 50.0, wipLimit = 2)
            val manualInside = TestPlan.capacityPeriod(t.teamId, "2049-03-17", 12.0)
            val manualFar = TestPlan.capacityPeriod(t.teamId, "2049-09-01", 7.0)
            val takenOver = ciSeedFlowPeriod(t.teamId, "2049-06-01", "9.00", 98, "Taken over")
            val client = t.manager.client
            assertEquals(
                HttpStatusCode.NoContent,
                client.putJson("/api/v1/capacity-periods/$takenOver", CapacityPeriodRequest("2049-06-01", 9.0)).status,
                "the manager takes the imported period over",
            )
            val flowLater = ciSeedFlowPeriod(t.teamId, "2049-03-29", "5.00", 3, "Flow later")
            val manual = listOf(manualStart, manualInside, manualFar, takenOver)
            val snapshot = manual.map(::ciRow)
            val everyManual = manual

            // Forged: the sprint whose start date a manual period holds, as a CREATE, as an UPDATE, with a figure that fits.
            for (action in listOf("CREATE", "UPDATE")) {
                val body = ciBody(FAR_FROM, listOf(ciItem(1, action, "2049-03-01", "20.0")))
                val forged = client.ciApply(binding.id, body).bodyAsText().fbObject()
                assertEquals(listOf("1"), forged.ciRows("skipped").map { it.ciText("sprintId") }, action)
                assertEquals(listOf(0, 0, 0), listOf("created", "updated", "deleted").map { forged.getValue(it).jsonArray.size }, action)
            }
            // Forged: every manual period named as a removal, alone and beside a legitimate UPDATE (sprint 3 reuses the FLOW period).
            val removals = client.ciApply(binding.id, ciBody(FAR_FROM, emptyList(), everyManual)).bodyAsText().fbObject()
            assertEquals(everyManual.map { it.toString() }, removals.ciRows("skipped").map { it.ciText("periodId") })
            assertEquals(0, removals.getValue("deleted").jsonArray.size)
            val beside = client.ciApply(binding.id, ciBody(FAR_FROM, listOf(ciItem(3, "UPDATE", "2049-03-29", "22.0")), everyManual))
                .bodyAsText().fbObject()
            val updated = beside.ciRows("updated").map { it.ciText("sprintId") to it.ciText("periodId") }
            assertEquals(listOf("3" to flowLater.toString()), updated)
            assertEquals(everyManual.size, beside.getValue("skipped").jsonArray.size)
            assertEquals("2049-03-29|22.00|-|FLOW|3|Flow later|false", ciRowShape(flowLater))
            // A MANUAL_PERIOD as the expected action is not a thing a person can tick: 400.
            for (action in listOf("MANUAL_PERIOD", "SKIP", "UNCHANGED")) {
                val bad = client.ciApply(binding.id, ciBody(FAR_FROM, listOf(ciItem(1, action, "2049-03-01", "20.0"))))
                assertEquals(HttpStatusCode.BadRequest, bad.status, action)
            }

            assertEquals(snapshot, manual.map(::ciRow), "no manual period moved: figure, WIP limit, source, stamp, flag")
            assertTrue(manual.all { id -> ciRow(id).split('|').let { it[3] == "MANUAL" && it[4] == "-" && it[6] == "false" } })
        }

    @Test
    fun `a row the plan no longer confirms is skipped CHANGED - a moved figure, a period taken over meanwhile, a deleted one`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("capa4", teams = true)
            val t = w.requireTeams()
            val sprints = { s1: String ->
                listOf(
                    ciSprint(1, "S1", "2049-03-01", "2049-03-12", s1),
                    ciSprint(2, "S2", "2049-03-15", "2049-03-26", "36"),
                    ciSprint(3, "S3", "2049-03-29", "2049-04-09", "44"),
                    ciSprint(4, "S4", "2049-04-12", "2049-04-23", "20"),
                )
            }
            val m = mirrorOf(planName("capa-flow"), sprints("40"))
            val binding = w.admin.client.fbBind(m.connectionId, 1, t.teamId).fbBinding()
            val s2 = ciSeedFlowPeriod(t.teamId, "2049-03-15", "15.00", 2, "S2")
            val r1 = ciSeedFlowPeriod(t.teamId, "2049-07-05", "9.00", 91, "R1")
            val r2 = ciSeedFlowPeriod(t.teamId, "2049-07-12", "9.00", 92, "R2")
            val r3 = ciSeedFlowPeriod(t.teamId, "2049-07-19", "9.00", 93, "R3")
            val client = t.manager.client
            val body = ciBodyOf(client.ciPreviewOf(binding.id), removals = listOf(r1, r2, r3))

            // Between the preview and the apply: S1's figure moves in Flow; S2's period is taken over by the manager; a manual period is
            // entered on S3's start; R1 is taken over, R2 deleted.
            m.refresh(flowTeamDoc(1, planName("capa-flow"), sprints = sprints("42")))
            assertEquals(HttpStatusCode.NoContent, client.putJson(periodPath(s2), CapacityPeriodRequest("2049-03-15", 14.0)).status)
            TestPlan.capacityPeriod(t.teamId, "2049-03-29", 33.0)
            assertEquals(HttpStatusCode.NoContent, client.putJson(periodPath(r1), CapacityPeriodRequest("2049-07-05", 8.0)).status)
            assertEquals(HttpStatusCode.NoContent, client.delete("/api/v1/capacity-periods/$r2").status)

            val response = client.ciApply(binding.id, body)

            assertEquals(HttpStatusCode.OK, response.status, response.bodyAsText())
            val result = response.bodyAsText().fbObject()
            assertEquals(listOf("4"), result.ciRows("created").map { it.ciText("sprintId") }, "S4 never moved")
            assertEquals(0, result.getValue("updated").jsonArray.size)
            assertEquals(listOf(r3), result.ids("deleted"))
            val skipped = result.ciRows("skipped")
            assertEquals(setOf("1", "2", "3"), skipped.mapNotNull { it["sprintId"]?.jsonPrimitive?.contentOrNull }.toSet())
            assertEquals(setOf(r1.toString(), r2.toString()), skipped.mapNotNull { it["periodId"]?.jsonPrimitive?.contentOrNull }.toSet())
            assertTrue(skipped.all { it.ciText("reason") == "CHANGED" })
            assertEquals("2049-03-15|14.00|-|MANUAL|-|-|false", ciRowShape(s2), "the manager's figure stands")
            assertEquals("2049-07-05|8.00|-|MANUAL|-|-|false", ciRowShape(r1), "a taken-over removal is not deleted")
            assertTrue(ciRowShape(r2).endsWith("|true") && ciRowShape(r3).endsWith("|true"))
        }

    @Test
    fun `a Flow team that left the mirror makes every row CHANGED - nothing is removed on the strength of an absence`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capa5", teams = true)
        val t = w.requireTeams()
        val m = mirrorOf(planName("capa-flow"), threeSprints())
        val binding = w.admin.client.fbBind(m.connectionId, 1, t.teamId).fbBinding()
        val gone = ciSeedFlowPeriod(t.teamId, "2049-07-05", "9.00", 99, "Gone sprint")
        val client = t.manager.client
        val body = ciBodyOf(client.ciPreviewOf(binding.id), removals = listOf(gone))
        m.refresh(flowTeamDoc(2, planName("capa-other")))
        val before = ciTeamRows(t.teamId)

        val result = client.ciApply(binding.id, body).bodyAsText().fbObject()

        assertEquals(listOf(0, 0, 0, 4), listOf("created", "updated", "deleted", "skipped").map { result.getValue(it).jsonArray.size })
        assertEquals(before, ciTeamRows(t.teamId))
    }

    @Test
    fun `ADMIN and the team's manager apply - every other caller is 403, even with a body that does not decode`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capa6", teams = true)
        val t = w.requireTeams()
        val m = mirrorOf(planName("capa-flow"), listOf(ciSprint(1, "S1", "2049-03-01", "2049-03-12", "40")))
        val binding = w.admin.client.fbBind(m.connectionId, 1, t.teamId).fbBinding()
        val body = ciBodyOf(w.admin.client.ciPreviewOf(binding.id))
        val outsiders = listOf(
            "other team's manager" to t.otherManager, "project owner" to w.projectOwner, "program owner" to w.programOwner,
            "stream owner" to w.streamOwner, "editor" to w.editor, "stranger" to w.stranger, "person-less login" to w.personless,
        )
        for ((who, caller) in outsiders) {
            assertEquals(HttpStatusCode.Forbidden, caller.client.ciApply(binding.id, body).status, who)
            assertEquals(HttpStatusCode.Forbidden, caller.client.ciApply(binding.id, "{ not json").status, "$who: 403 beats the 400")
        }
        assertTrue(ciTeamRows(t.teamId).isEmpty(), "a refused caller wrote nothing")
        val admin = w.admin.client.ciApply(binding.id, body)
        assertEquals(HttpStatusCode.OK, admin.status)
        assertEquals(1, admin.bodyAsText().fbObject().ciRows("created").size)
        // The manager, on the now-UNCHANGED plan: an empty (but valid) apply is a 200.
        assertEquals(HttpStatusCode.OK, t.manager.client.ciApply(binding.id, ciBody(FAR_FROM, emptyList())).status)
    }

    @Test
    fun `the order is binding 404 for every caller, then guard 403, then body 400 - and the 400s`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capa7", teams = true)
        val t = w.requireTeams()
        val m = mirrorOf(planName("capa-flow"), listOf(ciSprint(1, "S1", "2049-03-01", "2049-03-12", "40")))
        val binding = w.admin.client.fbBind(m.connectionId, 1, t.teamId).fbBinding()
        val everyone = listOf("admin" to w.admin, "manager" to t.manager, "stranger" to w.stranger, "person-less login" to w.personless)
        val ok = ciItem(1, "CREATE", "2049-03-01", "20.0")
        val many = (1..2_001).joinToString(",")
        val badBodies = listOf(
            "{ not json", "", "{}", """{"items":[]}""", """{"removals":[]}""",
            """{"from":"tomorrow","items":[],"removals":[]}""", """{"from":"1800-01-01","items":[],"removals":[]}""",
            """{"includeClosed":"yes","items":[],"removals":[]}""",
            """{"items":[{"sprintId":1,"expected":{"action":"CREATE","effectiveFrom":"2049-02-30","mdPerWeek":20}}],"removals":[]}""",
            """{"items":[{"sprintId":1,"expected":{"action":"CREATE","effectiveFrom":"2049-03-01","mdPerWeek":20.123}}],"removals":[]}""",
            """{"items":[{"sprintId":1,"expected":{"action":"CREATE","effectiveFrom":"2049-03-01","mdPerWeek":-1}}],"removals":[]}""",
            """{"items":[{"sprintId":1,"expected":{"action":"CREATE","effectiveFrom":"2049-03-01"}}],"removals":[]}""",
            ciBody(FAR_FROM, listOf(ok, ok)), ciBody(FAR_FROM, emptyList(), listOf(5u, 5u)),
            """{"items":[],"removals":[-1]}""",
        )
        // The bounds (2,000 rows each): once, as the manager - the bodies are the heavy ones.
        val oversized = listOf(
            """{"items":[],"removals":[$many]}""",
            """{"items":[${(1..2_001).joinToString(",") { ciItem(it.toLong(), "CREATE", "2049-03-01", "20.0") }}],"removals":[]}""",
        )
        for (body in oversized) assertEquals(HttpStatusCode.BadRequest, t.manager.client.ciApply(binding.id, body).status, "oversized")
        for ((who, caller) in listOf("admin" to w.admin, "manager" to t.manager)) {
            for (body in badBodies) {
                assertEquals(HttpStatusCode.BadRequest, caller.client.ciApply(binding.id, body).status, "$who: <${body.take(80)}>")
            }
        }
        val other = w.admin.client.fbBind(mirrorOf(planName("capa-two"), emptyList()).connectionId, 1, t.otherTeamId).fbBinding()
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/${t.otherTeamId}").status)
        for ((who, caller) in everyone) {
            assertEquals(HttpStatusCode.NotFound, caller.client.ciApply(999_999u, ciBody(FAR_FROM, listOf(ok))).status, "$who: unknown")
            assertEquals(HttpStatusCode.NotFound, caller.client.ciApply(999_999u, "{ not json").status, "$who: 404 beats the 400")
            assertEquals(HttpStatusCode.NotFound, caller.client.ciApply(other.id, "{ not json").status, "$who: the team is deleted")
        }
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("$FB_BINDINGS/${binding.id}").status)
        for ((who, caller) in everyone) {
            assertEquals(HttpStatusCode.NotFound, caller.client.ciApply(binding.id, ciBody(FAR_FROM, listOf(ok))).status, "$who: unlinked")
            assertEquals(HttpStatusCode.NotFound, caller.client.ciApply(binding.id, "{ not json").status, "$who: unlinked, bad body")
        }
        assertTrue(ciTeamRows(t.teamId).isEmpty(), "no refused request wrote a period")
    }

    @Test
    fun `an imported period the manager edits by hand is MANUAL - the next preview says MANUAL_PERIOD, the next apply leaves it`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("capa8", teams = true)
            val t = w.requireTeams()
            val m = mirrorOf(planName("capa-flow"), threeSprints())
            val binding = w.admin.client.fbBind(m.connectionId, 1, t.teamId).fbBinding()
            val client = t.manager.client
            val applied = client.ciApply(binding.id, ciBodyOf(client.ciPreviewOf(binding.id))).bodyAsText().fbObject()
            val s2 = applied.ciRows("created").single { it.ciText("sprintId") == "2" }.ciText("periodId").toUInt()

            assertEquals(HttpStatusCode.NoContent, client.putJson(periodPath(s2), CapacityPeriodRequest("2049-03-15", 18.0, 3)).status)

            assertEquals("2049-03-15|18.00|3|MANUAL|-|-|false", ciRowShape(s2), "even with the same figure the person's save takes it over")
            val preview = client.ciPreviewOf(binding.id)
            assertEquals(
                listOf("UNCHANGED", "MANUAL_PERIOD", "UNCHANGED"), preview.ciRows("items").map { it.ciText("action") },
            )
            val before = ciRow(s2)
            val forged = client.ciApply(binding.id, ciBody(FAR_FROM, listOf(ciItem(2, "UPDATE", "2049-03-15", "18.0")), listOf(s2)))
            assertEquals(2, forged.bodyAsText().fbObject().ciRows("skipped").size)
            assertEquals(before, ciRow(s2))
        }

    @Test
    fun `the service re-checks the writes it is handed - only FLOW periods change, a freed date is free, a bad batch writes nothing`() =
        runBlocking {
            val capacity = TeamCapacityService(sharedDatabaseForTests())
            val team = TestTeams.seed(planName("capa-svc"))
            try {
                val manual = TestPlan.capacityPeriod(team, "2049-01-05", 10.0)
                val flow = ciSeedFlowPeriod(team, "2049-02-01", "5.00", 7, "Old")
                val day = LocalDate.parse("2049-02-01")
                fun create(date: String, md: String = "6.00") = CapacityImportCreate(LocalDate.parse(date), BigDecimal(md), 8, "New")

                // Deletes go before inserts: a removed period's date is free for a create in the same batch.
                val applied = capacity.applyImport(team, { }) { rows ->
                    assertEquals(listOf(manual, flow), rows.map { it.id }, "the locked, active rows are what decide sees")
                    CapacityImportWrites(listOf(create("2049-02-01")), emptyList(), listOf(flow)) to "carried"
                }
                assertEquals("carried", applied.extra)
                assertEquals(listOf(flow), applied.deleted)
                assertEquals(day, applied.created.single().effectiveFrom)
                assertTrue(ciRowShape(flow).endsWith("|true"))
                assertEquals("2049-02-01|6.00|-|FLOW|8|New|false", ciRowShape(applied.created.single().periodId))

                // Guard rails: each of these aborts the batch, and the valid create beside it is NOT written.
                val live = applied.created.single().periodId
                val snapshot = ciTeamRows(team)
                val ok = create("2049-03-01")
                fun update(id: UInt) = CapacityImportUpdate(id, BigDecimal("1.00"), 1, "x")
                val bad = mapOf(
                    "update of a MANUAL period" to CapacityImportWrites(listOf(ok), listOf(update(manual)), emptyList()),
                    "delete of a MANUAL period" to CapacityImportWrites(listOf(ok), emptyList(), listOf(manual)),
                    "create on a taken date" to CapacityImportWrites(listOf(ok, create("2049-01-05")), emptyList(), emptyList()),
                    "two creates on one date" to CapacityImportWrites(listOf(ok, ok), emptyList(), emptyList()),
                    "a period written twice" to CapacityImportWrites(listOf(ok), listOf(update(live)), listOf(live)),
                    "an unknown period" to CapacityImportWrites(listOf(ok), emptyList(), listOf(live + 1000u)),
                )
                for ((label, writes) in bad) {
                    assertFailsWith<IllegalStateException>(label) { capacity.applyImport(team, { }) { writes to Unit } }
                    assertEquals(snapshot, ciTeamRows(team), "$label: nothing was written")
                }
                assertFailsWith<IllegalStateException>("a figure past the bounds") {
                    val huge = CapacityImportWrites(listOf(create("2049-03-01", "1000000.00")), emptyList(), emptyList())
                    capacity.applyImport(team, { }) { huge to Unit }
                }
                assertEquals(snapshot, ciTeamRows(team))

                // A rollback AFTER writes ran: the removal and the update are applied, then the insert fails server-side (a sprint name
                // past the column's 255 characters), and the whole transaction goes back - the removal and the update included.
                val other = ciSeedFlowPeriod(team, "2049-04-05", "4.00", 9, "Other")
                val before = ciTeamRows(team)
                val writes = CapacityImportWrites(
                    listOf(CapacityImportCreate(LocalDate.parse("2049-05-03"), BigDecimal("3.00"), 10, "x".repeat(300))),
                    listOf(update(other)),
                    listOf(live),
                )
                assertFails("the insert fails after the delete and the update ran") { capacity.applyImport(team, { }) { writes to Unit } }
                assertEquals(before, ciTeamRows(team), "the removal and the update were rolled back with the failed insert")
            } finally {
                jbSql("DELETE FROM team_capacity_periods WHERE team_id = ?", team.toInt())
                jbSql("DELETE FROM teams WHERE id = ?", team.toInt())
            }
        }
}
