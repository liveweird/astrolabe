package ch.nokillswit

import ch.nokillswit.planning.DependencyEndpoint
import ch.nokillswit.planning.DependencyListView
import ch.nokillswit.planning.EndpointKind
import ch.nokillswit.planning.EndpointRef
import kotlin.test.assertEquals

/**
 * Test-side join of the dependency list document (names once, 1.21.0): an end resolved through the document's three lists to the
 * project view's [DependencyEndpoint], WITHOUT dates (the list's ends carry none). Throws when a reference is not in the lists - the
 * "every ref resolves" claim. The same joining the SPA's `resolveDependencyList` does.
 */
internal fun DependencyListView.endOf(ref: EndpointRef): DependencyEndpoint = when (ref.kind) {
    EndpointKind.MILESTONE -> {
        val milestone = milestones.single { it.id == ref.id }
        DependencyEndpoint(
            kind = EndpointKind.MILESTONE,
            id = milestone.id,
            name = milestone.name,
            projectId = milestone.projectId,
            projectName = projects.single { it.id == milestone.projectId }.name,
            teamId = milestone.teamId,
            teamName = teams.single { it.id == milestone.teamId }.name,
            startDate = null,
            endDate = null,
        )
    }
    EndpointKind.PROJECT -> {
        val project = projects.single { it.id == ref.id }
        DependencyEndpoint(
            kind = EndpointKind.PROJECT,
            id = project.id,
            name = project.name,
            projectId = project.id,
            projectName = project.name,
            teamId = null,
            teamName = null,
            startDate = null,
            endDate = null,
        )
    }
}

/** The project view's end without its dates, to compare with [endOf]. */
internal fun DependencyEndpoint.withoutDates(): DependencyEndpoint = copy(startDate = null, endDate = null)

/**
 * The document's lists are exactly what its rows name: every reference resolves ([endOf]), no entry is unnamed by a row, each list is
 * by ascending id with no id twice. Returns normally when it holds; fails an assertion otherwise.
 */
internal fun DependencyListView.assertListsHoldExactlyWhatTheRowsName() {
    val ends = dependencies.flatMap { listOf(it.predecessor, it.successor) }
    ends.forEach { endOf(it) }
    val milestoneIds = ends.filter { it.kind == EndpointKind.MILESTONE }.map { it.id }.toSet()
    val projectIds = ends.filter { it.kind == EndpointKind.PROJECT }.map { it.id }.toSet() +
        milestones.map { it.projectId }
    assertEquals(milestoneIds.sorted(), milestones.map { it.id }, "milestones: exactly the named ones, ascending")
    assertEquals(projectIds.sorted(), projects.map { it.id }, "projects: exactly the named ones, ascending")
    assertEquals(milestones.map { it.teamId }.toSet().sorted(), teams.map { it.id }, "teams: exactly the named ones, ascending")
}
