package ch.nokillswit

import ch.nokillswit.flow.CapacityDeviationKind
import ch.nokillswit.sync.SyncTrigger
import ch.nokillswit.teams.CapacityPeriodRequest
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
 * 1.10: an acknowledgement lives only while its row is listed. The run's prune (inside the mirror replace), the acknowledge's own prune,
 * the capacity write's prune (1.14: a manual period or the import, through the `teams/` listener seam, after the write's commit) and
 * the connection delete, over the same scripted world as `CapacityAcknowledgeTest` (three 2049 sprints; day two: S2 a WARNING, S3 an
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
                assertEquals(2, capAckStored(bindingId), "no run, no acknowledge yet: still stored (raw SQL: no route told the listeners)")

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

    // 1.14: the plan-side writes. Day two says S2 30 (15 a week) and S3 48 (24 a week); the plan keeps 18 and 22 a week.

    private fun clearedLines(audit: LogCapture) = audit.events.filter { it.message == "flow.capacity_acknowledgements_cleared" }

    @Test
    fun `a capacity PUT that brings an acknowledged sprint in line clears its row, via capacity - the figure put back reads OPEN`() =
        testApplication {
            val world = dayTwo("capackp13")
            with(world) {
                val admin = w.admin.client
                acknowledgeBoth()
                val s3 = capAckPeriod(teamId, 3)
                withAuditCapture { audit ->
                    assertEquals(HttpStatusCode.NoContent, manager.client.capAckEdit(s3, 24.0).status)
                    assertNull(capAckRow(bindingId, 3), "sprint 3 is in line: its acknowledgement went before the answer")
                    assertNotNull(capAckRow(bindingId, 2), "sprint 2 is still listed")
                    val names = audit.events.map { it.message }
                        .filter { it == "team.capacity_period_updated" || it.startsWith("flow.capacity_") }
                    assertEquals(listOf("team.capacity_period_updated", "flow.capacity_acknowledgements_cleared"), names)
                    val cleared = clearedLines(audit).single()
                    keyValues(
                        cleared,
                        "byUserId" to manager.userId.toLong(), "bindingId" to bindingId.toLong(),
                        "connectionId" to mirror.connectionId.toLong(), "count" to 1, "sprintIds" to "3", "via" to "capacity",
                    )
                    assertTrue(cleared.keyValuePairs.none { it.key == "runId" }, "runId is a run's field only")
                }
                assertEquals(listOf(2L), admin.rowsOf().map { it.detail.sprintId }, "sprint 3 lists no row")

                assertEquals(HttpStatusCode.NoContent, manager.client.capAckEdit(s3, 22.0).status)
                assertNull(admin.rowOf(3).acknowledgement, "the same difference is OPEN, not acknowledged")
                assertEquals(1, capAckStored(bindingId))
            }
        }

    @Test
    fun `the capacity import's apply clears what it brings in line, one cleared line - a DELETE and a POST tell it too`() =
        testApplication {
            val world = dayTwo("capackp14")
            with(world) {
                val admin = w.admin.client
                acknowledgeBoth()
                val s2 = capAckPeriod(teamId, 2)
                val s3 = capAckPeriod(teamId, 3)
                val preview = manager.client.ciPreviewOf(bindingId)
                assertEquals(listOf("UNCHANGED", "UPDATE", "UPDATE"), preview.ciRows("items").map { it.ciText("action") })
                withAuditCapture { audit ->
                    assertEquals(HttpStatusCode.OK, manager.client.ciApply(bindingId, ciBodyOf(preview)).status)
                    assertEquals(0, capAckStored(bindingId), "both sprints are in line now")
                    val names = audit.events.map { it.message }.filter { it == "team.capacity_imported" || it.startsWith("flow.capacity_") }
                    assertEquals(listOf("team.capacity_imported", "flow.capacity_acknowledgements_cleared"), names)
                    keyValues(
                        clearedLines(audit).single(),
                        "byUserId" to manager.userId.toLong(), "bindingId" to bindingId.toLong(), "count" to 2, "sprintIds" to "2,3",
                        "via" to "capacity",
                    )
                }
                assertTrue(admin.rowsOf().isEmpty(), "nothing deviates")
                // Back to the old figures by hand: the same differences are OPEN.
                assertEquals(HttpStatusCode.NoContent, manager.client.capAckEdit(s2, 18.0).status)
                assertEquals(HttpStatusCode.NoContent, manager.client.capAckEdit(s3, 22.0).status)
                assertEquals(listOf(null, null), listOf(2L, 3L).map { admin.rowOf(it).acknowledgement })

                // A DELETE and a POST are capacity writes too: with its period gone sprint 3 still deviates (its acknowledgement stays,
                // stale), and a period that brings it in line from its first day clears the acknowledgement.
                admin.capAck(bindingId, 3, admin.rowOf(3).fingerprint).capAcknowledgement()
                withAuditCapture { audit ->
                    assertEquals(HttpStatusCode.NoContent, manager.client.delete("/api/v1/capacity-periods/${s3.id}").status)
                    assertNotNull(capAckRow(bindingId, 3), "the sprint is still listed without its period")
                    assertTrue(clearedLines(audit).isEmpty())
                    val created = manager.client.postJson("/api/v1/teams/$teamId/capacity", CapacityPeriodRequest(s3.from, 24.0))
                    assertEquals(HttpStatusCode.Created, created.status)
                    assertNull(capAckRow(bindingId, 3), "the new period brings sprint 3 in line")
                    keyValues(clearedLines(audit).single(), "sprintIds" to "3", "via" to "capacity")
                }
            }
        }

    @Test
    fun `a capacity figure that only moves keeps its acknowledgement STALE - nothing is cleared or audited`() = testApplication {
        val world = dayTwo("capackp15")
        with(world) {
            val admin = w.admin.client
            acknowledgeBoth()
            withAuditCapture { audit ->
                assertEquals(HttpStatusCode.NoContent, manager.client.capAckEdit(capAckPeriod(teamId, 3), 17.0).status)
                assertTrue(clearedLines(audit).isEmpty())
            }
            assertEquals(2, capAckStored(bindingId))
            assertEquals(false, admin.rowOf(3).acknowledgement?.current, "still listed, its figures moved: stale")
            assertEquals(true, admin.rowOf(2).acknowledgement?.current)
        }
    }

    @Test
    fun `a sprint missing from the mirror and a team absent from the document lose nothing to a capacity write`() = testApplication {
        val world = dayTwo("capackp16")
        with(world) {
            val admin = w.admin.client
            acknowledgeBoth()
            val s2 = capAckPeriod(teamId, 2)
            val s3 = capAckPeriod(teamId, 3)
            // Sprint 3 is not in the mirror (a truncated run keeps its row): the write judges sprint 2, which IS in the mirror, only.
            refreshOnly(1, 2, truncated = true)
            assertEquals(HttpStatusCode.NoContent, manager.client.capAckEdit(s2, 15.0).status)
            assertNull(capAckRow(bindingId, 2), "in the mirror and in line")
            assertNotNull(capAckRow(bindingId, 3), "missing from the mirror: 'gone from the document' is the run's call")

            refresh()
            assertEquals(HttpStatusCode.NoContent, manager.client.capAckEdit(s2, 18.0).status)
            admin.capAck(bindingId, 2, admin.rowOf(2).fingerprint).capAcknowledgement()
            assertEquals(2, capAckStored(bindingId))
            mirror.refresh(flowTeamDoc(2, "Billing")) // Flow team 1 is absent: nothing can be judged while it is gone
            withAuditCapture { audit ->
                assertEquals(HttpStatusCode.NoContent, manager.client.capAckEdit(s3, 24.0).status)
                assertTrue(clearedLines(audit).isEmpty())
            }
            assertEquals(2, capAckStored(bindingId))
            assertEquals(CapacityDeviationKind.TEAM_GONE, admin.rowsOf().single().kind)
        }
    }

    @Test
    fun `a capacity write clears the own row of a team that is present`() = testApplication {
        val world = dayTwo("capackp17")
        with(world) {
            // The state a failed prune could leave: a TEAM_GONE acknowledgement stored while the team is listed (the run clears it).
            jbSql(
                "INSERT INTO flow_capacity_acknowledgements (binding_id, sprint_id, fingerprint, ack_at, ack_by_user_id) " +
                    "VALUES (?, NULL, ?, 1, ?)",
                bindingId.toInt(), "a".repeat(64), w.admin.userId.toLong(),
            )
            assertEquals(1, capAckStored(bindingId))
            withAuditCapture { audit ->
                assertEquals(HttpStatusCode.NoContent, manager.client.capAckEdit(capAckPeriod(teamId, 1), 21.0).status)
                keyValues(clearedLines(audit).single(), "count" to 1, "sprintIds" to "none", "via" to "capacity")
            }
            assertEquals(0, capAckStored(bindingId))
        }
    }

    @Test
    fun `a write on an unlinked team, or on a bound team without stored rows, audits nothing`() = testApplication {
        val world = dayTwo("capackp18")
        with(world) {
            val admin = w.admin.client
            val s3 = capAckPeriod(teamId, 3)
            withAuditCapture { audit ->
                // Bound, no stored row at all: nothing to prune and no lock to take.
                assertEquals(HttpStatusCode.NoContent, manager.client.capAckEdit(s3, 24.0).status)
                assertEquals(
                    HttpStatusCode.Created,
                    admin.postJson("/api/v1/teams/${w.requireTeams().otherTeamId}/capacity", CapacityPeriodRequest("2049-05-03", 5.0))
                        .status,
                )
                assertTrue(clearedLines(audit).isEmpty())

                // Unlinked: its rows stay for the run (1.9's rule) and the write names no binding.
                assertEquals(HttpStatusCode.NoContent, manager.client.capAckEdit(s3, 22.0).status)
                admin.capAck(bindingId, 3, admin.rowOf(3).fingerprint).capAcknowledgement()
                assertEquals(HttpStatusCode.NoContent, admin.delete("$FB_BINDINGS/$bindingId").status)
                assertEquals(HttpStatusCode.NoContent, manager.client.capAckEdit(s3, 24.0).status)
                assertEquals(1, capAckStored(bindingId), "the unlinked binding's row is the run's to remove")
                assertTrue(clearedLines(audit).isEmpty())
            }
        }
    }
}
