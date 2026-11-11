package ch.nokillswit

import ch.nokillswit.plugins.ProblemDetail
import ch.nokillswit.teams.CapacityPeriodList
import ch.nokillswit.teams.CapacityPeriodRequest
import ch.nokillswit.teams.CapacityPeriodResponse
import ch.nokillswit.teams.CapacitySource
import ch.nokillswit.teams.CapacityWriteListener
import ch.nokillswit.teams.CapacityWriteListenersKey
import ch.nokillswit.teams.CapacityWriteTrail
import ch.qos.logback.classic.Level
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Team capacity periods (V16): `GET/POST /teams/{id}/capacity`, `GET/PUT/DELETE /capacity-periods/{id}`. Capacity is TEAM data written
 * by the team's manager or ADMIN and nobody else (above all not the project's owner), read-before-guard (404, 403, then the body),
 * dated on ANY calendar day, with an optional WIP limit `1..99`. The held-request, cascade and CHECK cases are `TeamCapacityLifecycleTest`.
 */
class TeamCapacityTest {
    private val forbidden = HttpStatusCode.Forbidden

    private fun collection(teamId: UInt) = "/api/v1/teams/$teamId/capacity"

    private fun period(id: UInt) = "/api/v1/capacity-periods/$id"

    private suspend fun HttpClient.add(teamId: UInt, from: String, md: Double, wip: Int? = null): HttpResponse =
        postJson(collection(teamId), CapacityPeriodRequest(from, md, wip))

    private suspend fun HttpClient.replace(id: UInt, from: String, md: Double, wip: Int? = null): HttpResponse =
        putJson(period(id), CapacityPeriodRequest(from, md, wip))

    private suspend fun HttpClient.rawPost(path: String, body: String): HttpResponse = post(path) {
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    private suspend fun HttpClient.read(id: UInt): CapacityPeriodResponse = get(period(id)).body()

    private suspend fun HttpResponse.problem(): ProblemDetail = body()

    @Test
    fun `the team's manager and ADMIN add a period - the project owner and every other caller get 403`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capmx", teams = true)
        val t = w.requireTeams()
        val created = mapOf(
            "manager" to t.manager.client.add(t.teamId, "2027-02-01", 10.0),
            "admin" to w.admin.client.add(t.teamId, "2027-03-01", 12.5, 3),
        )
        for ((label, response) in created) assertEquals(HttpStatusCode.Created, response.status, label)
        val denied = listOf(
            "project owner" to w.projectOwner, "program owner" to w.programOwner, "stream owner" to w.streamOwner,
            "stranger" to w.stranger, "personless" to w.personless, "roadmap editor" to w.editor,
            "the other team's manager" to t.otherManager,
        )
        for ((label, caller) in denied) {
            assertEquals(forbidden, caller.client.add(t.teamId, "2027-04-01", 5.0).status, label)
        }
        val stored = w.stranger.client.get(collection(t.teamId)).body<CapacityPeriodList>().items
        assertEquals(2, stored.size, "the refused writes stored nothing")
    }

    @Test
    fun `reads are open to every authenticated user - the list is ordered by date and one period reads back`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capread", teams = true)
        val t = w.requireTeams()
        val late = TestPlan.capacityPeriod(t.teamId, "2027-06-07", 20.0, wipLimit = 4)
        val early = TestPlan.capacityPeriod(t.teamId, "2027-02-01", 10.5)
        val otherTeam = TestPlan.capacityPeriod(t.otherTeamId, "2027-01-04", 1.0)
        val list = w.stranger.client.get(collection(t.teamId))
        assertEquals(HttpStatusCode.OK, list.status)
        assertEquals(listOf(early, late), list.body<CapacityPeriodList>().items.map { it.id }, "ordered by effectiveFrom, this team's only")
        val one = w.personless.client.read(late)
        assertEquals(
            CapacityPeriodResponse(late, t.teamId, "2027-06-07", 20.0, 4, one.createdAt, one.updatedAt, CapacitySource.MANUAL, null),
            one,
            "every period carries its source: a hand-entered one is MANUAL with no sprint",
        )
        assertNull(w.stranger.client.read(early).wipLimit)
        assertEquals(t.otherTeamId, w.stranger.client.read(otherTeam).teamId)
    }

    @Test
    fun `an unknown or deleted team or period is 404 for every caller, and a forbidden caller's malformed body stays 403`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("cap404", teams = true)
            val t = w.requireTeams()
            val period = TestPlan.capacityPeriod(t.teamId, "2027-02-01", 10.0)
            val gone = TestPlan.capacityPeriod(t.teamId, "2027-03-01", 10.0)
            assertEquals(HttpStatusCode.NoContent, t.manager.client.delete(period(gone)).status)
            for ((label, caller) in listOf("stranger" to w.stranger, "project owner" to w.projectOwner, "manager" to t.manager,
                "admin" to w.admin)) {
                assertEquals(HttpStatusCode.NotFound, caller.client.get(collection(999999u)).status, "list unknown: $label")
                assertEquals(HttpStatusCode.NotFound, caller.client.add(999999u, "2027-02-01", 1.0).status, "POST unknown team: $label")
                assertEquals(HttpStatusCode.NotFound, caller.client.get(period(999999u)).status, "GET unknown: $label")
                assertEquals(HttpStatusCode.NotFound, caller.client.replace(999999u, "2027-02-01", 1.0).status, "PUT unknown: $label")
                assertEquals(HttpStatusCode.NotFound, caller.client.delete(period(999999u)).status, "DELETE unknown: $label")
                assertEquals(HttpStatusCode.NotFound, caller.client.get(period(gone)).status, "GET deleted: $label")
                assertEquals(HttpStatusCode.NotFound, caller.client.replace(gone, "2027-02-01", 1.0).status, "PUT deleted: $label")
                assertEquals(HttpStatusCode.NotFound, caller.client.delete(period(gone)).status, "DELETE deleted: $label")
            }
            withAuditCapture { capture ->
                assertEquals(forbidden, w.projectOwner.client.rawPost(collection(t.teamId), "{ not json").status)
                assertEquals(forbidden, w.projectOwner.client.put(period(period)) {
                    contentType(ContentType.Application.Json)
                    setBody("{ not json")
                }.status)
                val owner = w.projectOwner.userId.toLong()
                assertNotNull(capture.awaitEvent { it.message == "authz.denied" && it.hasKeyValue("byUserId", owner) })
            }
            assertEquals(HttpStatusCode.BadRequest, t.manager.client.rawPost(collection(t.teamId), "{ not json").status,
                "the manager's malformed body is a 400")
        }

    @Test
    fun `a PUT on a Flow-sourced period makes it manual - even with the same values - and audits the takeover once`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capflow", teams = true)
        val t = w.requireTeams()
        val client = t.manager.client
        val created = client.add(t.teamId, "2047-03-02", 20.0, 3).body<CapacityPeriodResponse>()
        assertEquals(listOf(CapacitySource.MANUAL, null), listOf(created.source, created.flowSprintName), "a POST is always manual")
        val id = created.id
        // The import (a later step) writes these three columns; the API's job is what a PUT does to them.
        jbSql(
            "UPDATE team_capacity_periods SET source = 'FLOW', flow_sprint_id = 4711, flow_sprint_name = 'Sprint 12' WHERE id = ?",
            id.toInt(),
        )
        val imported = client.read(id)
        assertEquals(listOf(CapacitySource.FLOW, "Sprint 12"), listOf(imported.source, imported.flowSprintName))
        val listed = w.stranger.client.get(collection(t.teamId)).body<CapacityPeriodList>().items.single { it.id == id }
        assertEquals(CapacitySource.FLOW, listed.source, "the list carries the source too")

        withAuditCapture { capture ->
            // The manager saves the form unchanged: the figures are equal, the period is still taken over.
            assertEquals(HttpStatusCode.NoContent, client.replace(id, "2047-03-02", 20.0, 3).status)
            val taken = client.read(id)
            assertEquals(listOf(CapacitySource.MANUAL, null), listOf(taken.source, taken.flowSprintName))
            assertEquals(20.0, taken.mdPerWeek)
            assertNull(TestPlan.scalar("SELECT flow_sprint_id FROM team_capacity_periods WHERE id = $id") { it.getObject(1) })
            val event = capture.awaitEvent { it.message == "team.capacity_period_updated" && it.hasKeyValue("periodId", id.toLong()) }
            assertNotNull(event, "the takeover is audited")
            assertTrue(event.hasKeyValue("sourceFrom", "FLOW") && event.hasKeyValue("sourceTo", "MANUAL"))
            assertTrue(event.hasKeyValue("mdPerWeekFrom", 20.0) && event.hasKeyValue("mdPerWeekTo", 20.0))

            // Now it is manual: the same PUT again is the ordinary no-op (204, nothing written, nothing audited).
            assertEquals(HttpStatusCode.NoContent, client.replace(id, "2047-03-02", 20.0, 3).status)
            val updates = capture.events.count { it.message == "team.capacity_period_updated" && it.hasKeyValue("periodId", id.toLong()) }
            assertEquals(1, updates)
        }
    }

    @Test
    fun `a PUT that changes a Flow-sourced period's figures also makes it manual, and a manual period stays manual`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capflow2", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.capacityPeriod(t.teamId, "2047-04-06", 18.0)
        jbSql("UPDATE team_capacity_periods SET source = 'FLOW', flow_sprint_id = 1, flow_sprint_name = 'S' WHERE id = ?", id.toInt())
        assertEquals(HttpStatusCode.NoContent, t.manager.client.replace(id, "2047-04-13", 19.0, null).status)
        val moved = t.manager.client.read(id)
        assertEquals(
            listOf("2047-04-13", 19.0, CapacitySource.MANUAL, null),
            listOf(moved.effectiveFrom, moved.mdPerWeek, moved.source, moved.flowSprintName),
        )
        assertEquals(HttpStatusCode.NoContent, t.manager.client.replace(id, "2047-04-20", 20.0, null).status)
        assertEquals(CapacitySource.MANUAL, t.manager.client.read(id).source)
    }

    @Test
    fun `any date is accepted - a Tuesday, a Saturday, a date in the past and the calendar's edges`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capany", teams = true)
        val t = w.requireTeams()
        for (date in listOf("2027-02-02", "2027-02-06", "2020-01-06", "1900-01-01", "2999-12-31")) {
            val response = t.manager.client.add(t.teamId, date, 8.0)
            assertEquals(HttpStatusCode.Created, response.status, date)
            assertEquals(date, response.body<CapacityPeriodResponse>().effectiveFrom)
        }
    }

    @Test
    fun `the periods of a deleted team are gone - 404 on the list, the period and every write`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capgone", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.capacityPeriod(t.otherTeamId, "2027-09-01", 3.0)
        assertEquals(HttpStatusCode.NoContent, w.admin.client.delete("/api/v1/teams/${t.otherTeamId}").status)
        assertEquals(HttpStatusCode.NotFound, w.admin.client.get(collection(t.otherTeamId)).status)
        assertEquals(HttpStatusCode.NotFound, w.admin.client.get(period(id)).status, "its team is deleted")
        assertEquals(HttpStatusCode.NotFound, w.admin.client.replace(id, "2027-09-02", 1.0).status)
        assertEquals(HttpStatusCode.NotFound, w.admin.client.delete(period(id)).status)
        assertEquals(HttpStatusCode.NotFound, w.admin.client.add(t.otherTeamId, "2027-09-03", 1.0).status)
    }

    @Test
    fun `invalid payloads are 400 and store nothing - dates, man-days and the WIP limit`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("cap400", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.capacityPeriod(t.teamId, "2027-02-01", 10.0)
        val bad = listOf(
            """{"effectiveFrom":"2027-2-3","mdPerWeek":5}""" to "effectiveFrom must be a YYYY-MM-DD date",
            """{"effectiveFrom":"2027-02-30","mdPerWeek":5}""" to "effectiveFrom must be a YYYY-MM-DD date",
            """{"effectiveFrom":"2027-02-03T00:00:00Z","mdPerWeek":5}""" to "effectiveFrom must be a YYYY-MM-DD date",
            """{"effectiveFrom":"1899-12-31","mdPerWeek":5}""" to "effectiveFrom year must be between 1900 and 2999",
            """{"effectiveFrom":"3000-01-01","mdPerWeek":5}""" to "effectiveFrom year must be between 1900 and 2999",
            """{"effectiveFrom":"2027-03-01","mdPerWeek":-1}""" to "mdPerWeek must be a non-negative man-day figure",
            """{"effectiveFrom":"2027-03-01","mdPerWeek":1000000}""" to "mdPerWeek must be a non-negative man-day figure",
            """{"effectiveFrom":"2027-03-01","mdPerWeek":10.005}""" to "mdPerWeek must be a non-negative man-day figure",
            """{"effectiveFrom":"2027-03-01","mdPerWeek":5,"wipLimit":0}""" to "wipLimit must be between 1 and 99",
            """{"effectiveFrom":"2027-03-01","mdPerWeek":5,"wipLimit":100}""" to "wipLimit must be between 1 and 99",
            """{"effectiveFrom":"2027-03-01","mdPerWeek":5,"wipLimit":-3}""" to "wipLimit must be between 1 and 99",
            """{"effectiveFrom":"2027-03-01","mdPerWeek":5,"wipLimit":2.5}""" to "",
            """{"effectiveFrom":"2027-03-01","mdPerWeek":"abc"}""" to "",
            """{"mdPerWeek":5}""" to "",
            """{"effectiveFrom":"2027-03-01"}""" to "",
        )
        for ((body, detail) in bad) {
            val created = t.manager.client.rawPost(collection(t.teamId), body)
            assertEquals(HttpStatusCode.BadRequest, created.status, "POST $body")
            val actual = created.problem().detail.orEmpty()
            if (detail.isNotEmpty()) assertTrue(actual.startsWith(detail), "POST $body -> $actual")
            val replaced = t.manager.client.put(period(id)) {
                contentType(ContentType.Application.Json)
                setBody(body)
            }
            assertEquals(HttpStatusCode.BadRequest, replaced.status, "PUT $body")
        }
        assertEquals(listOf(id), t.manager.client.get(collection(t.teamId)).body<CapacityPeriodList>().items.map { it.id })
        assertEquals(10.0, t.manager.client.read(id).mdPerWeek, "the refused PUTs changed nothing")
    }

    @Test
    fun `the WIP limit is optional - absent and null store NULL - and the stored man-days are exactly the sent ones`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("capwip", teams = true)
            val t = w.requireTeams()
            val client = t.manager.client
            val absent = client.rawPost(collection(t.teamId), """{"effectiveFrom":"2027-02-01","mdPerWeek":12.5}""")
            val explicitNull = client.rawPost(collection(t.teamId), """{"effectiveFrom":"2027-02-08","mdPerWeek":0.1,"wipLimit":null}""")
            val seven = client.add(t.teamId, "2027-02-15", 0.0, 7)
            val edges = client.add(t.teamId, "2027-02-22", 999999.99, 99)
            for (response in listOf(absent, explicitNull, seven, edges)) assertEquals(HttpStatusCode.Created, response.status)
            val bodies = listOf(absent, explicitNull, seven, edges).map { it.body<CapacityPeriodResponse>() }
            val (a, b, c) = bodies
            val d = bodies[3]
            assertNull(a.wipLimit)
            assertNull(b.wipLimit)
            assertEquals(7, c.wipLimit)
            assertEquals(99, d.wipLimit)
            assertEquals("/api/v1/capacity-periods/${a.id}", absent.headers[HttpHeaders.Location])
            assertNull(TestPlan.scalar("SELECT wip_limit FROM team_capacity_periods WHERE id = ${a.id}") { it.getObject(1) })
            assertNull(TestPlan.scalar("SELECT wip_limit FROM team_capacity_periods WHERE id = ${b.id}") { it.getObject(1) })
            assertEquals(7, TestPlan.scalar("SELECT wip_limit FROM team_capacity_periods WHERE id = ${c.id}") { it.getInt(1) })
            val stored = listOf(a, b, c, d).map { p ->
                TestPlan.scalar("SELECT md_per_week::text FROM team_capacity_periods WHERE id = ${p.id}") { it.getString(1) }
            }
            assertEquals(listOf("12.50", "0.10", "0.00", "999999.99"), stored)
            val negativeZero = client.rawPost(collection(t.teamId), """{"effectiveFrom":"2027-03-01","mdPerWeek":-0.0}""")
            assertEquals(HttpStatusCode.Created, negativeZero.status)
            assertEquals(0.0, negativeZero.body<CapacityPeriodResponse>().mdPerWeek)
        }

    @Test
    fun `a start date is unique among the team's active periods - 409 on a POST and a PUT, a deleted period frees it`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("capdup", teams = true)
            val t = w.requireTeams()
            val client = t.manager.client
            val first = client.add(t.teamId, "2027-02-01", 10.0).body<CapacityPeriodResponse>()
            val second = client.add(t.teamId, "2027-03-01", 20.0).body<CapacityPeriodResponse>()
            val clash = client.add(t.teamId, "2027-02-01", 5.0)
            assertEquals(HttpStatusCode.Conflict, clash.status)
            assertEquals("A capacity period already starts on this date for this team", clash.problem().detail)
            assertEquals(HttpStatusCode.Conflict, client.replace(second.id, "2027-02-01", 20.0).status, "moving onto another period's date")
            assertEquals("2027-03-01", client.read(second.id).effectiveFrom, "the refused PUT changed nothing")
            assertEquals(HttpStatusCode.Created, w.admin.client.add(t.otherTeamId, "2027-02-01", 1.0).status, "another team may share it")
            assertEquals(HttpStatusCode.NoContent, client.delete(period(first.id)).status)
            assertEquals(HttpStatusCode.Created, client.add(t.teamId, "2027-02-01", 7.0).status, "the deleted period freed its date")
            assertEquals(HttpStatusCode.NoContent, client.replace(second.id, "2027-03-01", 21.0).status, "keeping its own date is no clash")
        }

    @Test
    fun `a PUT replaces the period - an absent limit clears it - and only the team's own manager or ADMIN may`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capput", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.capacityPeriod(t.teamId, "2027-02-01", 10.0, wipLimit = 3)
        for ((label, caller) in listOf("project owner" to w.projectOwner, "stranger" to w.stranger, "personless" to w.personless,
            "the other team's manager" to t.otherManager)) {
            assertEquals(forbidden, caller.client.replace(id, "2027-02-02", 1.0).status, "PUT $label")
            assertEquals(forbidden, caller.client.delete(period(id)).status, "DELETE $label")
        }
        assertEquals(10.0, w.admin.client.read(id).mdPerWeek, "nothing was written")
        assertEquals(HttpStatusCode.NoContent, t.manager.client.replace(id, "2027-02-02", 12.0, 5).status)
        val replaced = w.admin.client.read(id)
        assertEquals(listOf("2027-02-02", 12.0, 5), listOf(replaced.effectiveFrom, replaced.mdPerWeek, replaced.wipLimit))
        assertEquals(HttpStatusCode.NoContent, w.admin.client.put(period(id)) {
            contentType(ContentType.Application.Json)
            setBody("""{"effectiveFrom":"2027-02-02","mdPerWeek":12}""")
        }.status)
        assertNull(w.admin.client.read(id).wipLimit, "a PUT without wipLimit clears it")
    }

    @Test
    fun `delete is a soft delete - 204, then 404, the row stays flagged`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capdel", teams = true)
        val t = w.requireTeams()
        val id = TestPlan.capacityPeriod(t.teamId, "2027-02-01", 10.0)
        assertEquals(HttpStatusCode.NoContent, t.manager.client.delete(period(id)).status)
        assertEquals(HttpStatusCode.NotFound, t.manager.client.delete(period(id)).status)
        assertEquals(HttpStatusCode.NotFound, w.stranger.client.get(period(id)).status)
        assertEquals(emptyList(), w.stranger.client.get(collection(t.teamId)).body<CapacityPeriodList>().items)
        assertEquals(true, TestPlan.scalar("SELECT marked_as_deleted FROM team_capacity_periods WHERE id = $id") { it.getBoolean(1) })
    }

    @Test
    fun `every mutation is audited with its fields and a refused one is not - a no-op PUT emits nothing`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capaud", teams = true)
        val t = w.requireTeams()
        val client = t.manager.client
        withAuditCapture { capture ->
            val created = client.add(t.teamId, "2027-02-03", 8.0, 2).body<CapacityPeriodResponse>()
            val createdId = created.id.toLong()
            val createdEvent = capture.awaitEvent { it.message == "team.capacity_period_created" && it.hasKeyValue("periodId", createdId) }
            assertNotNull(createdEvent, "create audits")
            assertTrue(createdEvent.hasKeyValue("byUserId", t.manager.userId.toLong()))
            assertTrue(createdEvent.hasKeyValue("teamId", t.teamId.toLong()))
            assertTrue(createdEvent.hasKeyValue("effectiveFrom", "2027-02-03"))
            assertTrue(createdEvent.hasKeyValue("mdPerWeek", 8.0))
            assertTrue(createdEvent.hasKeyValue("wipLimit", 2))
            val unlimited = client.add(t.teamId, "2027-03-03", 8.0).body<CapacityPeriodResponse>()
            val unlimitedId = unlimited.id.toLong()
            assertNotNull(capture.awaitEvent {
                it.message == "team.capacity_period_created" && it.hasKeyValue("periodId", unlimitedId) &&
                    it.hasKeyValue("wipLimit", "none")
            }, "a null limit audits as none")

            client.replace(created.id, "2027-02-04", 9.5, null)
            val updated = capture.awaitEvent { it.message == "team.capacity_period_updated" && it.hasKeyValue("periodId", createdId) }
            assertNotNull(updated, "an actual change audits")
            assertTrue(updated.hasKeyValue("effectiveFromFrom", "2027-02-03") && updated.hasKeyValue("effectiveFromTo", "2027-02-04"))
            assertTrue(updated.hasKeyValue("mdPerWeekFrom", 8.0) && updated.hasKeyValue("mdPerWeekTo", 9.5))
            assertTrue(updated.hasKeyValue("wipLimitFrom", 2) && updated.hasKeyValue("wipLimitTo", "none"), "the PUT cleared the limit")
            assertTrue(updated.hasKeyValue("teamId", t.teamId.toLong()) && updated.hasKeyValue("byUserId", t.manager.userId.toLong()))

            assertEquals(HttpStatusCode.NoContent, client.replace(created.id, "2027-02-04", 9.5, null).status)
            assertEquals(HttpStatusCode.Conflict, client.replace(created.id, "2027-03-03", 9.5, null).status)
            assertEquals(HttpStatusCode.BadRequest, client.add(t.teamId, "2027-05-05", -1.0).status)
            assertEquals(forbidden, t.otherManager.client.add(t.teamId, "2027-05-05", 1.0).status)
            client.delete(period(created.id))
            val teamId = t.teamId.toLong()
            assertNotNull(capture.awaitEvent {
                it.message == "team.capacity_period_deleted" && it.hasKeyValue("periodId", createdId) && it.hasKeyValue("teamId", teamId)
            })
            val mine = capture.events.filter { it.hasKeyValue("teamId", teamId) }
            assertEquals(2, mine.count { it.message == "team.capacity_period_created" }, "refused creates emit nothing")
            assertEquals(1, mine.count { it.message == "team.capacity_period_updated" }, "the no-op and the 409 emit nothing")
            assertEquals(1, mine.count { it.message == "team.capacity_period_deleted" })
        }
    }


    /** One step of a capacity write as the registered listener saw it: `lock`, `settle`, or `told` (the follow-up after the commit). */
    private class Seen(val team: UInt, val what: String, val by: UInt? = null, val auditLines: Int = 0)

    /**
     * Registers a listener that records, in order, the lock before the team row, the settle and - once the write committed - the
     * follow-up with its caller and the number of `team.capacity_period_*` audit lines already written.
     */
    private fun ApplicationTestBuilder.recordCapacityWrites(audit: LogCapture): MutableList<Seen> {
        val seen = CopyOnWriteArrayList<Seen>()
        application.attributes[CapacityWriteListenersKey].register(object : CapacityWriteListener {
            override suspend fun lockBeforeTeam(teamId: UInt): List<UInt> {
                seen += Seen(teamId, "lock")
                return listOf(teamId + 1000u)
            }

            override suspend fun settle(teamId: UInt, locked: List<UInt>, trail: CapacityWriteTrail) {
                seen += Seen(teamId, "settle")
                assertEquals(listOf(teamId + 1000u), locked, "settle gets back what the lock step answered")
                trail.afterCommit { byUserId ->
                    seen += Seen(teamId, "told", byUserId, audit.events.count { it.message.startsWith("team.capacity_period_") })
                }
            }
        })
        return seen
    }

    @Test
    fun `a committed POST, a changed PUT and a DELETE each lock, settle inside the write and tell once after their audit line`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("capltn", teams = true)
            val t = w.requireTeams()
            val client = t.manager.client
            withAuditCapture { audit ->
                val seen = recordCapacityWrites(audit)
                fun of(what: String) = seen.filter { it.team == t.teamId && it.what == what }

                val created = client.add(t.teamId, "2027-02-03", 8.0, 2).body<CapacityPeriodResponse>()
                val steps = seen.filter { it.team == t.teamId }.map { it.what }
                assertEquals(listOf("lock", "settle", "told"), steps, "lock, settle, then told")
                val told = of("told").map { it.by to it.auditLines }
                assertEquals(listOf(t.manager.userId to 1), told, "told once, after the create's audit line")

                assertEquals(HttpStatusCode.NoContent, w.admin.client.replace(created.id, "2027-02-04", 9.5).status)
                assertEquals(listOf(t.manager.userId, w.admin.userId), of("told").map { it.by }, "the changed PUT: its caller")
                assertEquals(2, of("told").last().auditLines, "after the update's audit line")

                // Nothing settles or is told for a same-values PUT, a clash, a bad body, a forbidden caller or an unknown team or period.
                assertEquals(HttpStatusCode.NoContent, client.replace(created.id, "2027-02-04", 9.5).status)
                assertEquals(HttpStatusCode.Conflict, client.add(t.teamId, "2027-02-04", 1.0).status)
                assertEquals(HttpStatusCode.BadRequest, client.add(t.teamId, "2027-05-05", -1.0).status)
                assertEquals(forbidden, t.otherManager.client.add(t.teamId, "2027-05-05", 1.0).status)
                assertEquals(forbidden, t.otherManager.client.replace(created.id, "2027-02-05", 1.0).status)
                assertEquals(forbidden, t.otherManager.client.delete(period(created.id)).status)
                assertEquals(HttpStatusCode.NotFound, client.add(999999u, "2027-05-05", 1.0).status)
                assertEquals(HttpStatusCode.NotFound, client.replace(999999u, "2027-05-05", 1.0).status)
                assertEquals(HttpStatusCode.NotFound, client.delete(period(999999u)).status)
                assertEquals(2, of("settle").size, "the refused and no-op writes settled nothing")
                assertEquals(2, of("told").size, "and told nobody")

                assertEquals(HttpStatusCode.NoContent, client.delete(period(created.id)).status)
                assertEquals(listOf(t.manager.userId, w.admin.userId, t.manager.userId), of("told").map { it.by })
                assertEquals(3, of("told").last().auditLines, "after the delete's audit line")
                assertEquals(HttpStatusCode.NotFound, client.delete(period(created.id)).status)
                assertEquals(3, of("settle").size, "a second DELETE of the gone period settled nothing")
                assertEquals(3, of("told").size)
            }
        }

    @Test
    fun `a follow-up that throws after the commit leaves the write's status and audit as they are - one WARN names only the class`() =
        testApplication {
            usePostgresTestcontainer()
            val w = planWorld("capltw", teams = true)
            val t = w.requireTeams()
            val told = CopyOnWriteArrayList<UInt>()
            application.attributes[CapacityWriteListenersKey].register(object : CapacityWriteListener {
                override suspend fun lockBeforeTeam(teamId: UInt) = emptyList<UInt>()

                override suspend fun settle(teamId: UInt, locked: List<UInt>, trail: CapacityWriteTrail) {
                    trail.afterCommit { told += teamId }
                    trail.afterCommit { error("secret detail that must not be logged") }
                    trail.afterCommit { told += teamId }
                }
            })
            val warnings = LogCapture("ch.nokillswit.teams.CapacityWriteTrail")
            try {
                withAuditCapture { audit ->
                    val created = t.manager.client.add(t.teamId, "2027-02-03", 8.0)
                    assertEquals(HttpStatusCode.Created, created.status, "the write stands")
                    val id = created.body<CapacityPeriodResponse>().id.toLong()
                    assertNotNull(audit.awaitEvent { it.message == "team.capacity_period_created" && it.hasKeyValue("periodId", id) })
                    assertEquals(listOf(t.teamId, t.teamId), told, "the follow-ups either side of the failing one ran")
                    val logged = warnings.events.filter { it.level == Level.WARN }
                    assertEquals(1, logged.size)
                    val line = logged.single().formattedMessage
                    assertTrue("IllegalStateException" in line, line)
                    assertTrue("secret" !in line, "the exception's message is never logged")
                }
            } finally {
                warnings.detach()
            }
        }

    @Test
    fun `a listener that fails inside the write aborts it - nothing is stored, nothing is audited, nobody is told`() = testApplication {
        usePostgresTestcontainer()
        val w = planWorld("capltf", teams = true)
        val t = w.requireTeams()
        val told = CopyOnWriteArrayList<UInt>()
        application.attributes[CapacityWriteListenersKey].register(object : CapacityWriteListener {
            override suspend fun lockBeforeTeam(teamId: UInt) = emptyList<UInt>()

            override suspend fun settle(teamId: UInt, locked: List<UInt>, trail: CapacityWriteTrail) {
                trail.afterCommit { told += teamId }
                error("the listener's settle failed")
            }
        })
        withAuditCapture { audit ->
            assertEquals(HttpStatusCode.InternalServerError, t.manager.client.add(t.teamId, "2027-02-03", 8.0).status)
            val stored = w.stranger.client.get(collection(t.teamId)).body<CapacityPeriodList>().items
            assertTrue(stored.isEmpty(), "the period rolled back with the failed settle")
            assertTrue(told.isEmpty())
            assertTrue(audit.events.none { it.message == "team.capacity_period_created" })
        }
    }
}
