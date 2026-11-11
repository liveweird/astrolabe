package ch.nokillswit.users

import ch.nokillswit.infra.db.active
import ch.nokillswit.people.PersonService
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*

/**
 * One batched read of `people.user_id` (V10): the ACTIVE person linked to each of [ids] (at most one each, the
 * `uq_people_user_id_active` index), for `UserResponse.personId`. Runs in the caller's transaction (`UserService.list`
 * and `read`), unlocked; a soft-deleted person is absent.
 */
internal suspend fun linkedPersonIds(ids: Collection<UInt>): Map<UInt, UInt> {
    if (ids.isEmpty()) return emptyMap()
    val people = PersonService.People
    return people.select(people.id, people.userId)
        .where { (people.userId inList ids) and people.active() }
        .toList()
        .mapNotNull { row -> row[people.userId]?.value?.let { it to row[people.id].value } }
        .toMap()
}
