package ch.nokillswit

import ch.nokillswit.jira.JiraImportPreview
import ch.nokillswit.jira.JiraImportRoot
import ch.nokillswit.jira.JiraImportRootLevel
import ch.nokillswit.jira.JiraLevel

// Helpers of the rooted import's tests (1.14, `JiraImportChildren*Test`). The stub's `IMC` project: `IMC-n` is the Jira id 99000 + n
// (`IMC-1` the program root of a program import, `IMC-2` the project root, `IMC-14` a program with nothing under it, `IMC-11..13` another
// program's tree that no rooted read lists). Nothing here touches the stub (`StubWarmupGuardTest`: a helper file may not): the classes
// that read its request journal do it themselves and warm it in a `@BeforeClass`. The `jira-import` bucket is 5 calls a minute per user:
// a test keeps each caller within it.

/** The Jira id of `IMC-[n]`. */
internal fun imcId(n: Int) = "${99_000 + n}"

internal fun programRoot(f: ImportFixture) = JiraImportRoot(JiraImportRootLevel.PROGRAM, f.w.programId)

internal fun projectRoot(f: ImportFixture) = JiraImportRoot(JiraImportRootLevel.PROJECT, f.w.projectId)

/** Links the world's program to [key] (as the administrator, through the fixture's connection) and answers it as the import's root. */
internal suspend fun ImportFixture.linkProgram(key: String = "IMC-1"): JiraImportRoot {
    w.admin.client.jbBind(connectionId, JiraLevel.PROGRAM, w.programId, key).jbBinding()
    return programRoot(this)
}

/** Links the world's project to [key] and answers it as the import's root. */
internal suspend fun ImportFixture.linkProject(key: String = "IMC-2"): JiraImportRoot {
    w.admin.client.jbBind(connectionId, JiraLevel.PROJECT, w.projectId, key).jbBinding()
    return projectRoot(this)
}

internal fun JiraImportPreview.keys(): List<String> = items.map { it.key() }
