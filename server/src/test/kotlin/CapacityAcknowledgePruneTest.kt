package ch.nokillswit

import ch.nokillswit.flow.CapacityDeviationKind
import ch.nokillswit.sync.SyncTrigger
import io.ktor.client.request.delete
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 1.10: an acknowledgement lives only while its row is listed. The run's prune (inside the mirror replace), the acknowledge's own prune
 * and the connection delete, over the same scripted world as `CapacityAcknowledgeTest` (three 2049 sprints; day two: S2 a WARNING, S3 an
 * INFO, Billing gone). The predicate per binding state - listed row kept, in line / left the document / zero sprints pruned, an ABSENT
 * team and a sprints-truncated document pruning nothing, an unlinked binding and a dead team pruned whole - is pinned here; the lock
 * order and the waits are `CapacityAcknowledgeRaceTest`'s.
 */
class CapacityAcknowledgePruneTest {
    private val mirrors = mutableListOf<ScriptedFlowMirror>()

    @AfterTest
    fun cleanUp() {
        mirrors.forEach { it.cleanUp() }
        mirrors.clear()
        removeFlowFixtureRows(CAPACK_PREFIX)
    }

    private suspend fun ApplicationTestBuilder.dayTwo(label: String): CapAckWorld = capAckWorld(label, mirrors).also { it.refresh() }

    /** Acknowledges sprints 2 and 3 of the E2E team's binding as ADMIN (the row's current fingerprints). */
    private suspend fun CapAckWorld.acknowledgeBoth() {
        val admin = w.admin.client
        admin.capAck(bindingId, 2, admin.rowOf(2).fingerprint).capAcknowledgement()
        admin.capAck(bindingId, 3, admin.rowOf(3).fingerprint).capAcknowledgement()
        assertEquals(2, capAckStored(bindingId))
    }

    private fun keyValues(event: ch.qos.logback.classic.spi.ILoggingEvent, vararg expected: Pair<String, Any>) {
        for ((key, value) in expected) assertTrue(event.hasKeyValue(key, value), "$key=$value in ${event.keyValuePairs}")
    }

    @Test
    fun `a sprint that leaves Flow's document loses its acknowledgement at the run - a listed sprint keeps it`() = testApplication {
        val world = dayTwo("capackp1")
        with(world) {
            val admin = w.admin.client
            acknowledgeBoth()
            refreshOnly(1, 3)
            assertNull(capAckRow(bindingId, 2), "sprint 2 is no longer in the document")
            assertNotNull(capAckRow(bindingId, 3), "sprint 3 is still listed: its acknowledgement stays")
            val rows = admin.rowsOf()
            assertEquals(listOf(3L), rows.map { it.detail.sprintId })
            assertEquals(true, rows.single().acknowledgement?.current)

            refresh()
            assertNull(admin.rowOf(2).acknowledgement, "sprint 2 comes back: its difference is open")
            assertEquals(true, admin.rowOf(3).acknowledgement?.current)
        }
    }

    @Test
    fun `a STALE acknowledgement stays - its row is still listed, only its figures moved`() = testApplication {
        val world = dayTwo("capackp2")
        with(world) {
            val admin = w.admin.client
            acknowledgeBoth()
            jbSql("UPDATE team_capacity_periods SET md_per_week = 17 WHERE team_id = ? AND flow_sprint_id = 2", teamId.toInt())
            refresh()
            assertEquals(2, capAckStored(bindingId), "both rows are still listed (sprint 2 differs by another figure now)")
            assertEquals(false, admin.rowOf(2).acknowledgement?.current, "stale, as before")
        }
    }

    @Test
    fun `a team that goes ABSENT keeps its sprint acknowledgements and still reads acknowledged when it returns with the same figures`() =
        testApplication {
            val world = dayTwo("capackp3")
            with(world) {
                val admin = w.admin.client
                acknowledgeBoth()
                mirror.refresh(flowTeamDoc(2, "Billing")) // Flow team 1 is absent: nothing can be judged while it is gone
                assertEquals(CapacityDeviationKind.TEAM_GONE, admin.rowsOf().single().kind)
                assertEquals(2, capAckStored(bindingId), "a transient absence wipes no decision")

                refresh()
                assertEquals(listOf(true, true), admin.rowsOf().map { it.acknowledgement?.current }, "same figures again: acknowledged")
            }
        }

    @Test
    fun `a sprints-truncated document prunes nothing, a complete one prunes - and a listed team with ZERO sprints clears only then`() =
        testApplication {
            val world = dayTwo("capackp4")
            with(world) {
                acknowledgeBoth()
                refreshOnly(1, 3, truncated = true)
                assertEquals(2, capAckStored(bindingId), "sprint 2 is missing from a document cut at the sprint cap: not sent, not gone")
                refreshOnly(truncated = true)
                assertEquals(2, capAckStored(bindingId), "the team listed with ZERO sprints in a truncated document: nothing is judged")

                refreshOnly()
                assertEquals(0, capAckStored(bindingId), "the same team with zero sprints in a COMPLETE document: every row left the list")

                refresh()
                acknowledgeBoth()
                refreshOnly(1, 3)
                assertEquals(listOf(3L), listOf(2L, 3L).filter { capAckRow(bindingId, it) != null }, "a complete document: sprint 2 only")
            }
        }

    @Test
    fun `an unlinked binding's rows survive the unlink and go at the connection's next run, a dead team's too`() = testApplication {
        val world = dayTwo("capackp5")
        with(world) {
            val admin = w.admin.client
            val billingManager = w.requireTeams().otherManager.client
            admin.capAck(bindingId, 2, admin.rowOf(2).fingerprint).capAcknowledgement()
            billingManager.capAck(billingBindingId, null, admin.rowOf(null, billingBindingId).fingerprint).capAcknowledgement()

            assertEquals(HttpStatusCode.NoContent, admin.delete("$FB_BINDINGS/$bindingId").status)
            jbSql("UPDATE teams SET marked_as_deleted = TRUE WHERE id = ?", w.requireTeams().otherTeamId.toInt())
            assertEquals(1, capAckStored(bindingId), "an unlink leaves the rows (as in 1.9)")
            assertEquals(1, capAckStored(billingBindingId), "a team delete leaves them too: `teams/` names nothing of `flow/`")

            refresh()
            assertEquals(0, capAckStored(bindingId), "the unlinked binding lists nothing: the run removed its rows")
            assertEquals(0, capAckStored(billingBindingId), "so does a deleted team's binding - even while its Flow team is absent")
        }
    }

    @Test
    fun `the acknowledge prunes its own binding - a sprint brought in line by a plan edit loses its row at the next acknowledge`() =
        testApplication {
            val world = dayTwo("capackp6")
            with(world) {
                val admin = w.admin.client
                val s2 = admin.rowOf(2)
                acknowledgeBoth()
                // Day two says 48 for sprint 3 (24 a week over ten working days): the plan is brought in line by a manual edit.
                jbSql("UPDATE team_capacity_periods SET md_per_week = 24 WHERE team_id = ? AND flow_sprint_id = 3", teamId.toInt())
                assertEquals(listOf(2L), admin.rowsOf().map { it.detail.sprintId }, "sprint 3 is in line: its row left the list")
                assertEquals(2, capAckStored(bindingId), "no run and no acknowledge yet: the row is still stored (the plan-side residual)")

                withAuditCapture { audit ->
                    assertEquals(HttpStatusCode.OK, manager.client.capAck(bindingId, 2, s2.fingerprint).status)
                    assertNull(capAckRow(bindingId, 3), "the acknowledge pruned sprint 3's row")
                    assertNotNull(capAckRow(bindingId, 2))
                    val names = audit.events.map { it.message }.filter { it.startsWith("flow.capacity_") }
                    assertEquals(listOf("flow.capacity_deviation_acknowledged", "flow.capacity_acknowledgements_cleared"), names)
                    val cleared = audit.events.single { it.message == "flow.capacity_acknowledgements_cleared" }
                    keyValues(
                        cleared,
                        "byUserId" to manager.userId.toLong(), "bindingId" to bindingId.toLong(),
                        "connectionId" to mirror.connectionId.toLong(), "count" to 1, "sprintIds" to "3", "via" to "acknowledge",
                    )
                    assertTrue(cleared.keyValuePairs.none { it.key == "runId" }, "runId is a run's field only")
                }
                refreshOnly(1, 2, 3)
                assertEquals(listOf(2L), listOf(2L, 3L).filter { capAckRow(bindingId, it) != null })
            }
        }

    @Test
    fun `an acknowledge that prunes nothing audits no cleared line, and the team's own row is never pruned by a sprint acknowledge`() =
        testApplication {
            val world = dayTwo("capackp7")
            with(world) {
                val admin = w.admin.client
                val s2 = admin.rowOf(2)
                withAuditCapture { audit ->
                    assertEquals(HttpStatusCode.OK, admin.capAck(bindingId, 2, s2.fingerprint).status)
                    assertTrue(audit.events.none { it.message == "flow.capacity_acknowledgements_cleared" })
                }
                // The gone team's own row: acknowledging it prunes nothing (nothing can be judged while the team is gone).
                val billing = w.requireTeams().otherManager.client
                val goneRow = admin.rowOf(null, billingBindingId)
                assertEquals(HttpStatusCode.OK, billing.capAck(billingBindingId, null, goneRow.fingerprint).status)
                assertEquals(1, capAckStored(billingBindingId))
            }
        }

    @Test
    fun `deleting the connection removes every acknowledgement of its bindings and audits the count`() = testApplication {
        val world = dayTwo("capackp8")
        with(world) {
            val admin = w.admin.client
            acknowledgeBoth()
            w.requireTeams().otherManager.client.capAck(billingBindingId, null, admin.rowOf(null, billingBindingId).fingerprint)
                .capAcknowledgement()
            assertEquals(3, capAckStored(bindingId) + capAckStored(billingBindingId))

            withAuditCapture { audit ->
                assertEquals(HttpStatusCode.NoContent, admin.delete("$FB_CONNECTIONS/${mirror.connectionId}").status)
                val event = assertNotNull(audit.awaitEvent { it.message == "flow.connection_deleted" })
                keyValues(
                    event, "connectionId" to mirror.connectionId.toLong(), "bindingsUnbound" to 2, "acknowledgementsDeleted" to 3,
                )
            }
            assertEquals(0, capAckStored(bindingId) + capAckStored(billingBindingId), "no row outlives its connection")
        }
    }

    @Test
    fun `a run audits one cleared line per binding with its requester, a scheduled run has none, a run that prunes nothing is silent`() =
        testApplication {
            val world = dayTwo("capackp9")
            with(world) {
                val admin = w.admin.client
                acknowledgeBoth()
                val sync = LogCapture("ch.nokillswit.sync")
                try {
                    withAuditCapture { audit ->
                        refreshOnly(1, 2, 3, trigger = SyncTrigger.MANUAL, byUserId = w.admin.userId)
                        assertTrue(audit.events.none { it.message == "flow.capacity_acknowledgements_cleared" }, "nothing left the list")
                        assertTrue(sync.events.none { it.formattedMessage.contains("capacity acknowledgement") })

                        refreshOnly(1, 3, trigger = SyncTrigger.MANUAL, byUserId = w.admin.userId)
                        val requested = audit.events.single { it.message == "flow.capacity_acknowledgements_cleared" }
                        keyValues(
                            requested,
                            "byUserId" to w.admin.userId.toLong(), "bindingId" to bindingId.toLong(),
                            "connectionId" to mirror.connectionId.toLong(), "count" to 1, "sprintIds" to "2", "via" to "run",
                            "runId" to mirror.harness.lastRun(mirror.connectionId).id.toLong(),
                        )
                        val info = "cleared 1 capacity acknowledgement(s) whose row left the list"
                        assertEquals(1, sync.events.count { it.formattedMessage.endsWith(info) })

                        refresh()
                        admin.capAck(bindingId, 2, admin.rowOf(2).fingerprint).capAcknowledgement()
                        refreshOnly(1, 3, trigger = SyncTrigger.SCHEDULED)
                        val scheduled = audit.events.last { it.message == "flow.capacity_acknowledgements_cleared" }
                        val byUser = scheduled.keyValuePairs.singleOrNull { it.key == "byUserId" }
                        assertTrue(byUser != null && byUser.value == null, "a scheduled run has no user")
                        keyValues(scheduled, "bindingId" to bindingId.toLong(), "sprintIds" to "2", "via" to "run")
                        assertEquals(2, audit.events.count { it.message == "flow.capacity_acknowledgements_cleared" })
                    }
                } finally {
                    sync.detach()
                }
            }
        }

    @Test
    fun `a sprints-truncated document still clears a returned team's gone acknowledgement - its sprint rows are not judged`() =
        testApplication {
            val world = dayTwo("capackp11")
            with(world) {
                val admin = w.admin.client
                acknowledgeBoth()
                mirror.refresh(flowTeamDoc(2, "Billing")) // the team vanishes ...
                admin.capAck(bindingId, null, admin.rowOf(null).fingerprint).capAcknowledgement() // ... and its gone row is acknowledged
                assertEquals(3, capAckStored(bindingId), "both sprint rows and its own row")

                refreshOnly(1, truncated = true) // the team returns in a document cut at the sprint cap (sprints 2 and 3 not sent)
                assertNull(capAckRow(bindingId, null), "the returned team's own row is cleared whatever the cap says (1.9's rule)")
                assertEquals(2, capAckStored(bindingId), "the sprint rows are not judged by a truncated document")

                mirror.refresh(flowTeamDoc(2, "Billing")) // it vanishes AGAIN: a new, OPEN disappearance
                val again = admin.rowOf(null)
                assertEquals(CapacityDeviationKind.TEAM_GONE, again.kind)
                assertNull(again.acknowledgement, "reads open: the earlier acknowledgement did not survive the return")
            }
        }

    @Test
    fun `an acknowledge leaves a sprint missing from the mirror to the run - a truncated run keeps it too`() = testApplication {
        val world = dayTwo("capackp12")
        with(world) {
            val admin = w.admin.client
            val s2 = admin.rowOf(2)
            acknowledgeBoth()
            refreshOnly(1, 2, truncated = true) // sprint 3 is not in the mirror now: not sent, not necessarily gone
            assertEquals(2, capAckStored(bindingId), "a truncated run keeps sprint 3's acknowledgement")
            withAuditCapture { audit ->
                assertEquals(HttpStatusCode.OK, admin.capAck(bindingId, 2, s2.fingerprint).status)
                assertNotNull(capAckRow(bindingId, 3), "the acknowledge does not judge 'gone from the document': it cannot know why")
                assertTrue(audit.events.none { it.message == "flow.capacity_acknowledgements_cleared" })
            }
            refreshOnly(1, 2) // a COMPLETE document confirms it: sprint 3 is gone
            assertNull(capAckRow(bindingId, 3))
        }
    }

    @Test
    fun `the team's own row is audited as none, ascending with the sprints`() = testApplication {
        val world = dayTwo("capackp10")
        with(world) {
            val admin = w.admin.client
            // A binding holding BOTH sprint rows and its own row: acknowledge the sprints, let the team vanish, acknowledge TEAM_GONE.
            acknowledgeBoth()
            mirror.refresh(flowTeamDoc(2, "Billing"))
            admin.capAck(bindingId, null, admin.rowOf(null).fingerprint).capAcknowledgement()
            assertEquals(3, capAckStored(bindingId))
            withAuditCapture { audit ->
                refreshOnly(1)
                assertEquals(0, capAckStored(bindingId))
                keyValues(
                    audit.events.single { it.message == "flow.capacity_acknowledgements_cleared" }, "count" to 3, "sprintIds" to "none,2,3",
                )
            }
        }
    }
}
