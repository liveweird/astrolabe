package ch.nokillswit.users

import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.db.lockActiveForWrite
import ch.nokillswit.users.UserService.UserDisabledFeatures
import ch.nokillswit.users.UserService.UserPermissions
import ch.nokillswit.users.UserService.Users
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*

/**
 * The per-user grant tables behind [UserService]: the DISABLED feature set (V5, `user_disabled_features`, no row =
 * enabled) and the GRANT permission set (V11, `user_permissions`, a row = held). Every function runs in the CALLER's
 * transaction (`UserService` opens exactly one per public function and delegates here); nothing here opens, joins or
 * splits one, so each lock sits in the transaction it always did.
 */
internal object UserGrants {
    /**
     * Wholesale-replace the user's disabled-feature set (V5). Returns 1, or 0 when the id is
     * unknown or soft-deleted (the route 404s). Idempotent — a same-set re-PUT is a no-op
     * replace, not a transition.
     */
    suspend fun replaceDisabledFeatures(id: UInt, features: Set<Feature>): Int {
        val exists = Users.select(Users.id)
            .where { (Users.id eq id) and Users.active() }
            .toList()
            .isNotEmpty()
        if (!exists) return 0
        UserDisabledFeatures.deleteWhere { UserDisabledFeatures.userId eq id }
        features.forEach { f ->
            UserDisabledFeatures.insert {
                it[userId] = id
                it[feature] = f.name
            }
        }
        return 1
    }

    /**
     * Whether [userId] holds [permission] (V11), read from the database on every call — the per-request check
     * behind `requireRoadmapEditorOrAdmin`; never cached and never a JWT claim, so a grant or revoke applies on
     * the very next request. A soft-deleted user's login is already a 401 at the access check, and their rows
     * stay inert, so no `active()` join is needed here.
     */
    suspend fun hasPermission(userId: UInt, permission: Permission): Boolean =
        UserPermissions.select(UserPermissions.userId)
            .where { (UserPermissions.userId eq userId) and (UserPermissions.permission eq permission.name) }
            .limit(1)
            .toList()
            .isNotEmpty()

    /**
     * Wholesale-replace the user's granted-permission set (V11) and return the set it replaced, or null when the id is
     * unknown or soft-deleted (the route 404s). Idempotent — a same-set re-PUT rewrites the same rows. The user row is
     * locked `FOR NO KEY UPDATE` for the replace so two concurrent PUTs serialize instead of racing on the primary key,
     * and the returned previous set is exact for the audit event.
     */
    suspend fun replacePermissions(id: UInt, permissions: Set<Permission>): Set<Permission>? {
        if (!Users.lockActiveForWrite(id)) return null
        val previous = permissionsOf(id)
        UserPermissions.deleteWhere { UserPermissions.userId eq id }
        permissions.forEach { p ->
            UserPermissions.insert {
                it[userId] = id
                it[permission] = p.name
            }
        }
        return previous
    }

    suspend fun featuresOf(id: UInt): Set<Feature> =
        UserDisabledFeatures.selectAll()
            .where { UserDisabledFeatures.userId eq id }
            .map { Feature.valueOf(it[UserDisabledFeatures.feature]) }
            .toList()
            .toSet()

    suspend fun disabledFeaturesByUserIds(ids: List<UInt>): Map<UInt, List<Feature>> =
        if (ids.isEmpty()) emptyMap()
        else UserDisabledFeatures.selectAll()
            .where { UserDisabledFeatures.userId inList ids }
            .toList()
            .groupBy({ it[UserDisabledFeatures.userId].value }, { Feature.valueOf(it[UserDisabledFeatures.feature]) })

    suspend fun permissionsOf(id: UInt): Set<Permission> =
        UserPermissions.selectAll()
            .where { UserPermissions.userId eq id }
            .map { Permission.valueOf(it[UserPermissions.permission]) }
            .toList()
            .toSet()

    suspend fun permissionsByUserIds(ids: List<UInt>): Map<UInt, List<Permission>> =
        if (ids.isEmpty()) emptyMap()
        else UserPermissions.selectAll()
            .where { UserPermissions.userId inList ids }
            .toList()
            .groupBy({ it[UserPermissions.userId].value }, { Permission.valueOf(it[UserPermissions.permission]) })
}
