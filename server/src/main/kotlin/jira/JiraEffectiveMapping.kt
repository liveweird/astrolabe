package ch.nokillswit.jira

import ch.nokillswit.authz.ConflictException

/**
 * What a connection's mapping amounts to RIGHT NOW: the ONE resolution the bind and the run share. The stored document if there is one,
 * else the defaults the discovery resolves; either must fit the discovery as it is now ([mappingProblems]), because a later Test
 * connection can replace the snapshot under a saved mapping. Nothing here ever rewrites the stored document.
 */
internal sealed interface MappingResolution {
    class Usable(val mapping: JiraMapping) : MappingResolution

    /** A stored document this build cannot decode. */
    data object Unreadable : MappingResolution

    /** The first reason the effective mapping does not fit the discovery (the same text a `409`/failed run carries). */
    class Invalid(val problem: String) : MappingResolution
}

internal fun resolveEffectiveMapping(state: JiraMappingState, discovery: JiraDiscovery): MappingResolution {
    if (state.stored == StoredMapping.Unreadable) return MappingResolution.Unreadable
    val mapping = state.mapping ?: JiraMappingDefaults.resolve(discovery)
    mappingProblems(mapping, discovery).firstOrNull()?.let { return MappingResolution.Invalid(it) }
    return MappingResolution.Usable(mapping)
}

/**
 * The issue-type ids the run's queries name (the FULL read and the sweep): those at EVERY mapped level (`issuetype in (...)`). Null when
 * a mapped level has none in the snapshot's `issueTypes` - the snapshot can be cut at its cap while its `levels` grouping is complete, so
 * [mappingProblems] passing does not imply a usable list, and `JiraJql.scopeAndTypes` throws on an empty one - or when a site sent an id
 * that is not digits (the clause takes numeric ids only). Either is a `MAPPING_INVALID` before anything is read or written.
 */
internal fun sweepTypeIds(mapping: JiraMapping, discovery: JiraDiscovery): List<String>? {
    val perLevel = mapping.mappedLevels().map { (_, mapped) -> discovery.typeIdsAtLevel(mapped.hierarchyLevel) }
    if (perLevel.any { it.isEmpty() }) return null
    return perLevel.flatten().distinct().takeIf { ids -> ids.all(JiraJql::isTypeId) }
}

/** The stored mapping, else the defaults (the bind's, Peek's and the import's resolution); `409` if unfit or unreadable. */
internal fun effectiveMapping(state: JiraMappingState, discovery: JiraDiscovery): JiraMapping =
    when (val resolved = resolveEffectiveMapping(state, discovery)) {
        is MappingResolution.Usable -> resolved.mapping
        MappingResolution.Unreadable -> throw ConflictException(
            "The connection's stored mapping cannot be read - ask an administrator to save it again", JIRA_MAPPING_INVALID_PROBLEM,
        )
        is MappingResolution.Invalid -> throw ConflictException(
            "The connection's mapping no longer fits the site (${resolved.problem}) - ask an administrator to update it",
            JIRA_MAPPING_INVALID_PROBLEM,
        )
    }
