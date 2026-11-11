package ch.nokillswit

import ch.nokillswit.infra.db.buildFlyway
import org.flywaydb.core.Flyway
import org.flywaydb.core.api.FlywayException
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFailsWith

/**
 * The rollback promise of the release notes (1.13, `persistence.md`): an OLDER build boots on a database that a newer build
 * migrated further. The older build's Flyway sees applied migrations it does not ship and must accept them as "future" (Flyway's
 * default `*:future` ignore pattern) instead of failing validation. Nothing else pins that default, so an explicit
 * `ignoreMigrationPatterns(...)` in `buildFlyway` would break every rollback silently. The test validates the shared, fully
 * migrated container with the shipped configuration but only the migrations up to V28 (a 1.12 build's set), then proves the
 * check bites: the same set without the ignore pattern fails.
 */
class FlywayFutureMigrationsTest {

    @Test
    fun `the shipped Flyway configuration accepts migrations newer than the build, as a 1_12 build on the 1_13 schema`() {
        PostgresTestSupport.ensureMigrated()
        val olderBuild = Files.createTempDirectory("astrolabe-v28-migrations").toFile()
        try {
            File("src/main/resources/db/migration").listFiles().orEmpty()
                .filter { versionOf(it) <= OLDER_BUILD_LATEST }
                .forEach { it.copyTo(File(olderBuild, it.name)) }
            val shipped = buildFlyway(PostgresTestSupport.jdbcUrl, PostgresTestSupport.user, PostgresTestSupport.password, 0)
            fun older(configure: (org.flywaydb.core.api.configuration.FluentConfiguration) -> Unit = {}) = Flyway.configure()
                .configuration(shipped.configuration)
                .locations("filesystem:${olderBuild.absolutePath}")
                .also(configure)
                .load()

            older().validate()
            assertFailsWith<FlywayException>("without *:future the newer applied migrations fail validation") {
                older { it.ignoreMigrationPatterns(*emptyArray<String>()) }.validate()
            }
        } finally {
            olderBuild.deleteRecursively()
        }
    }

    private fun versionOf(file: File): Int = file.name.substringAfter('V').substringBefore("__").toInt()

    private companion object {
        /** The newest migration a 1.12 build ships. */
        const val OLDER_BUILD_LATEST = 28
    }
}
