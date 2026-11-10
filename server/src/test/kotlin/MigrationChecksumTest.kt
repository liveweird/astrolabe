package ch.nokillswit

import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.CRC32
import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.name
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pins the Flyway checksum of every migration file. An APPLIED migration's bytes may never
 * change — comments included: Flyway validates stored checksums against the files at startup
 * (`validateOnMigrate`, the default), so any edit to an already-applied migration makes every
 * existing database refuse to boot with a checksum mismatch. This gate turns that silent
 * production-only failure into a red test: editing a listed file fails here, and the fix is
 * to revert the edit (a comment clarification belongs in `.claude/docs/persistence.md`), never
 * to update the pinned value. Adding a NEW migration adds one line — compute it with the same
 * algorithm below, or read it from `flyway_schema_history` after the first local run.
 */
class MigrationChecksumTest {
    private val pinned = mapOf(
        "V1__init.sql" to -1123925117,
        "V2__create_revoked_tokens.sql" to 794001362,
        "V3__seed_admin.sql" to -1667901562,
        "V4__enable_unaccent_extension.sql" to 242547752,
        "V5__user_disabled_features.sql" to -222068373,
        "V6__create_teams.sql" to 1111670690,
        "V7__user_credential_revision.sql" to 289120118,
        "V8__password_reset_tokens.sql" to 1662294880,
        "V9__create_ops_telemetry.sql" to -782122896,
        "V10__people_and_team_manager_person.sql" to -438551672,
        "V11__user_permissions.sql" to 1624709150,
        "V12__plan_structure.sql" to -2119029713,
        "V13__roadmap_entries.sql" to 356464108,
        "V14__milestones.sql" to -1637747327,
        "V15__dependencies.sql" to 1553016569,
        "V16__team_capacity_periods.sql" to 1065717060,
        "V17__team_milestone_orders.sql" to 1891634852,
        "V18__ranking_revision.sql" to 1265434272,
        "V19__public_holidays.sql" to 695505857,
        "V20__baselines.sql" to -44892282,
        // Re-pinned twice in 1.1.0 (C6 `mapping_changed_at`; C10 the `api_token` envelope CHECK and the `sync_runs.requested_by_user_id`
        // FK): V21 had only been applied by throwaway test containers, never to real data. Immutable from the first real upgrade.
        "V21__jira_sync.sql" to -1791624565,
        "V22__jira_polling_and_acknowledge.sql" to 1567303519,
        "V23__jira_census.sql" to -1388010118,
        "V24__flow_sync.sql" to -852538185,
        "V25__milestone_pin.sql" to -588653258,
        "V26__flow_capacity_acknowledgements.sql" to 1641040429,
    )

    @Test
    fun `every migration file matches its applied Flyway checksum`() {
        val dir = Path.of("src/main/resources/db/migration")
        val files = dir.listDirectoryEntries("*.sql").associate { it.name to flywayChecksum(it) }
        assertEquals(
            pinned.keys.sorted(),
            files.keys.sorted(),
            "Migration files and the pinned manifest must list the same set — add the new file's checksum here",
        )
        for ((name, expected) in pinned) {
            assertEquals(
                expected,
                files.getValue(name),
                "$name changed after being applied — revert the edit; existing databases would fail Flyway validation",
            )
        }
    }

    // Flyway's algorithm: CRC32 over each line's UTF-8 bytes (terminators excluded), BOM stripped.
    private fun flywayChecksum(file: Path): Int {
        val crc = CRC32()
        Files.readString(file).removePrefix("﻿").lineSequence().forEach { crc.update(it.toByteArray()) }
        return crc.value.toInt()
    }
}
