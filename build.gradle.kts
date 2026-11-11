
plugins {
    alias(libs.plugins.kotlin.multiplatform) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.kover)
}

buildscript {
    configurations.classpath {
        resolutionStrategy.activateDependencyLocking()
    }
    dependencies {
        constraints {
            // Keep the root plugin classpath above the FreeMarker path-traversal advisory floor.
            classpath("org.freemarker:freemarker:2.3.35")
        }
    }
}

// Keep resolved build, test, and runtime modules reproducible and visible to the
// vulnerability scanner. Refresh with `./gradlew dependencies --write-locks` for each project.
allprojects {
    dependencyLocking {
        lockAllConfigurations()
        lockMode = org.gradle.api.artifacts.dsl.LockMode.STRICT
    }
}

subprojects {
    group = "ch.nokillswit"
    version = "1.0.0-SNAPSHOT"
}

// The settings plugins DSL resolves before project buildscript locking is available. Resolve
// the same marker here using the shared version property so its implementation enters the
// root lockfile and the vulnerability scan without adding it to the application classpath.
val settingsPluginAudit = configurations.create("settingsPluginAudit") {
    isCanBeConsumed = false
    isCanBeResolved = true
}

dependencies {
    kover(project(":server"))
    add(
        settingsPluginAudit.name,
        "org.gradle.toolchains.foojay-resolver-convention:org.gradle.toolchains.foojay-resolver-convention.gradle.plugin:${providers.gradleProperty("foojayResolverVersion").get()}",
    )
}

tasks.register("verifySettingsPluginAudit") {
    group = "verification"
    description = "Resolves the locked settings plugin graph before vulnerability scanning."
    doLast {
        settingsPluginAudit.resolve()
    }
}

// Fails when gradle/verification-metadata.xml still carries a component the current locks have moved past — the trail a
// dependency bump leaves, since `--write-verification-metadata` only ever ADDS to an existing file (a clean regeneration
// needs the file deleted first, .claude/docs/dependency-reproducibility.md "Pruning"). Cheap and offline: it reads the
// metadata and the seven lockfiles, never the network, a cache or a regeneration. Two rules:
//   1. LOCKED: a component group:name that some lockfile locks, present in the metadata at a version no lockfile locks
//      for it, is superseded (an old jar/pom/module left behind by a bump).
//   2. FAMILY: a POM-only parent or BOM (all its artifacts are .pom/.module) that no lockfile locks by name, whose group
//      has locked components, and at least one of whose versions equals a locked version in the group (so the family
//      moves in lockstep with its members: netty-parent with netty-*, flyway-parent with flyway-*), is superseded at any
//      version no component of the group is locked at.
// What neither rule can see is whether a lingering entry is still READ by a surviving component's POM chain (a conflict
// loser's BOM, a third-party artifact's old parent): that lives in POM contents, not in the metadata or the locks. Those
// entries are listed in `keptSuperseded` below, each with the reason a clean regeneration keeps it; the check fails on a
// stale allowlist line too, so the list cannot rot. When it fails on a NEW entry, regenerate per the doc: if the clean
// regeneration drops it, delete the entry; if it keeps it, add one line to the allowlist saying why.
abstract class CheckVerificationMetadata : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val metadata: RegularFileProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val lockfiles: ConfigurableFileCollection

    /** `group:name:version` -> why a clean regeneration keeps the entry although the rules flag it. */
    @get:Input
    abstract val keptSuperseded: MapProperty<String, String>

    private data class Entry(val group: String, val name: String, val version: String, val pomOnly: Boolean) {
        val coordinate get() = "$group:$name:$version"
    }

    @TaskAction
    fun verify() {
        val lockedByModule = HashMap<String, MutableSet<String>>()
        val lockedByGroup = HashMap<String, MutableSet<String>>()
        for (file in lockfiles.files) {
            val lines = file.readLines().map { it.trim() }
            val lockLines = lines.filter { it.isNotEmpty() && !it.startsWith("#") && !it.startsWith("empty=") }
            // A lockfile with no lock line is fine only when Gradle wrote it that way (an `empty=` line); anything else is a
            // truncated or blanked file, which would silently switch rule 1 off for every group it locks.
            check(lockLines.isNotEmpty() || lines.any { it.startsWith("empty=") }) { "${file.name} has no locked line and no empty= line — truncated?" }
            lockLines.forEach { line ->
                val parts = line.substringBefore('=').split(':')
                check(parts.size == 3) { "${file.name}: not a group:name:version lock line: $line" }
                lockedByModule.getOrPut("${parts[0]}:${parts[1]}") { sortedSetOf() }.add(parts[2])
                lockedByGroup.getOrPut(parts[0]) { sortedSetOf() }.add(parts[2])
            }
        }
        check(lockedByModule.isNotEmpty()) { "No locked module found in ${lockfiles.files.map { it.name }} — is the lock layout still what the check reads?" }

        val factory = javax.xml.parsers.DocumentBuilderFactory.newInstance()
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        val components = factory.newDocumentBuilder().parse(metadata.get().asFile).getElementsByTagName("component")
        val entries = (0 until components.length).map { i ->
            val element = components.item(i) as org.w3c.dom.Element
            val artifacts = element.getElementsByTagName("artifact")
            val names = (0 until artifacts.length).map { (artifacts.item(it) as org.w3c.dom.Element).getAttribute("name") }
            Entry(
                element.getAttribute("group"), element.getAttribute("name"), element.getAttribute("version"),
                names.isNotEmpty() && names.all { it.endsWith(".pom") || it.endsWith(".module") },
            )
        }
        check(entries.isNotEmpty()) { "${metadata.get().asFile.name} lists no component — is the file still the Gradle verification metadata?" }

        val pomVersionsByName = entries.filter { it.pomOnly }.groupBy({ "${it.group}:${it.name}" }, { it.version })
        val flagged = entries.mapNotNull { entry ->
            val module = "${entry.group}:${entry.name}"
            val lockedHere = lockedByModule[module]
            val groupLocks = lockedByGroup[entry.group].orEmpty()
            when {
                lockedHere != null ->
                    if (entry.version in lockedHere) null
                    else entry to "$module is locked at ${lockedHere.joinToString()} only (rule 1, locked)"
                entry.pomOnly && entry.version !in groupLocks && pomVersionsByName.getValue(module).any { it in groupLocks } ->
                    entry to "no ${entry.group} component is locked at ${entry.version}, though some ${entry.name} version moves with them (rule 2, family)"
                else -> null
            }
        }
        val allowed = keptSuperseded.get()
        val unexplained = flagged.filter { it.first.coordinate !in allowed }
        val stale = allowed.keys - flagged.map { it.first.coordinate }.toSet()
        check(unexplained.isEmpty() && stale.isEmpty()) {
            buildString {
                append("gradle/verification-metadata.xml is not free of superseded entries.")
                if (unexplained.isNotEmpty()) {
                    append("\nSuperseded, remove (or allowlist with a reason if a clean regeneration keeps it):")
                    unexplained.forEach { (entry, why) -> append("\n  ${entry.coordinate}: $why") }
                }
                if (stale.isNotEmpty()) {
                    append("\nAllowlisted but no longer flagged or no longer present, remove these keptSuperseded lines:")
                    stale.sorted().forEach { append("\n  $it") }
                }
                append("\nRegeneration and pruning: .claude/docs/dependency-reproducibility.md \"Pruning superseded entries\".")
            }
        }
        logger.lifecycle("${metadata.get().asFile.path}: ${entries.size} components, none superseded (${allowed.size} allowlisted as kept by a clean regeneration)")
    }
}

// `-PverificationMetadataFile=<path>` points the check at another copy of the metadata (the proof against a pre-prune file).
val checkVerificationMetadata = tasks.register<CheckVerificationMetadata>("checkVerificationMetadata") {
    group = "verification"
    description = "Fails when gradle/verification-metadata.xml keeps a component the lockfiles have moved past."
    metadata.set(
        providers.gradleProperty("verificationMetadataFile").map { layout.projectDirectory.file(it) }
            .orElse(layout.projectDirectory.file("gradle/verification-metadata.xml")),
    )
    lockfiles.from(
        listOf(
            "gradle.lockfile", "buildscript-gradle.lockfile", "settings-gradle.lockfile",
            "core/gradle.lockfile", "core/buildscript-gradle.lockfile",
            "server/gradle.lockfile", "server/buildscript-gradle.lockfile",
        ).map { layout.projectDirectory.file(it) },
    )
    // Each line names the POM/module in the clean-regeneration cache that still reads the entry (traced 2026-11-12), so the line
    // can be re-checked and dropped the day its referrer goes.
    keptSuperseded.putAll(
        mapOf(
            "com.fasterxml.jackson:jackson-bom:2.19.2" to "imported by log4j 2.26.1's parent POM",
            "com.fasterxml.jackson:jackson-bom:2.21.1" to "imported by the jib-gradle-plugin 3.5.4 POM",
            "com.fasterxml.jackson:jackson-bom:2.21.3" to "imported by openapi-request-validator 3.0.0",
            "com.fasterxml.jackson:jackson-bom:2.22.1" to "imported by swagger-parser-project 2.1.48",
            "io.netty:netty-bom:4.2.19.Final" to "imported by flyway-parent 13.12.0",
            "io.opentelemetry:opentelemetry-bom:1.49.0" to "imported by httpclient5-parent 5.6.4",
            "org.jetbrains.kotlinx:kotlinx-coroutines-bom:1.6.4" to "the BOM of kotlinx-coroutines-core-jvm 1.6.4, a losing transitive version",
            "org.jetbrains.kotlinx:kotlinx-coroutines-bom:1.8.0" to "the BOM of kotlinx-coroutines-core-jvm 1.8.0, a losing transitive version",
            "com.google.guava:guava-parent:26.0-android" to "the parent of listenablefuture 9999.0-empty-to-avoid-conflict-with-guava",
            "com.google.guava:guava-parent:33.4.0-android" to "the parent of failureaccess 1.0.3",
        ),
    )
}
