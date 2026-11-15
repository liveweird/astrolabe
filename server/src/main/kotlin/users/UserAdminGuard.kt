package ch.nokillswit.users

import ch.nokillswit.infra.db.active
import ch.nokillswit.infra.validation.canonicalEmail
import ch.nokillswit.users.UserService.GuardedMutation
import ch.nokillswit.users.UserService.Users
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.*
import org.jetbrains.exposed.v1.r2dbc.*

/**
 * The last-admin guard behind [UserService.updateGuarded] and [UserService.deleteGuarded]: the check and the write
 * share the CALLER's transaction (`UserService` opens exactly one per public function and delegates here), the
 * active-admin rows locked via [lockedActiveAdminCount], so two concurrent demotes cannot both observe "two admins
 * left" and demote both — the read-then-count-then-update split across separate transactions was a TOCTOU. Nothing
 * here opens, joins or splits a transaction.
 */
internal object UserAdminGuard {
    /**
     * Updates the identity fields + role together with the last-admin check — password and passwordChangedAt stay
     * untouched.
     */
    suspend fun update(id: UInt, name: String, email: String, role: UserRole): GuardedMutation {
        validateNameAndEmail(name, email) // re-checked service-side so direct callers stay guarded
        val existingRole = activeRole(id) ?: return GuardedMutation.NOT_FOUND
        if (existingRole == UserRole.ADMIN && role != UserRole.ADMIN && lockedActiveAdminCount() <= 1) {
            return GuardedMutation.LAST_ADMIN
        }
        val rows = Users.update({ (Users.id eq id) and Users.active() }) {
            it[Users.name] = name
            // Canonical identity, folded here too (defense-in-depth like findWithIdByEmail).
            it[Users.email] = canonicalEmail(email)
            it[Users.role] = role.name
        }
        return if (rows == 0) GuardedMutation.NOT_FOUND else GuardedMutation.DONE
    }

    /**
     * Soft delete with the last-admin check in the SAME transaction (see [update]):
     * blocks login, refresh rejects `user_gone`, the V1 partial index frees the email.
     */
    suspend fun delete(id: UInt): GuardedMutation {
        val existingRole = activeRole(id) ?: return GuardedMutation.NOT_FOUND
        if (existingRole == UserRole.ADMIN && lockedActiveAdminCount() <= 1) {
            return GuardedMutation.LAST_ADMIN
        }
        val rows = Users.update({ (Users.id eq id) and Users.active() }) {
            it[markedAsDeleted] = true
        }
        return if (rows == 0) GuardedMutation.NOT_FOUND else GuardedMutation.DONE
    }

    /** Backs the routes' fast-path 409 pre-checks (the ordering gate; correctness lives in the guarded mutations). */
    suspend fun countActiveAdmins(): Long =
        Users.selectAll().where { (Users.role eq UserRole.ADMIN.name) and Users.active() }.count()

    private suspend fun activeRole(id: UInt): UserRole? =
        Users.select(Users.role)
            .where { (Users.id eq id) and Users.active() }
            .toList()
            .singleOrNull()
            ?.let { UserRole.valueOf(it[Users.role]) }

    // FOR UPDATE on the active-admin rows serializes concurrent admin mutations: the second
    // transaction blocks on the first's locks and re-evaluates the predicate after its commit,
    // so a demoted/deleted row no longer counts. Admins are few — counting in memory is fine.
    private suspend fun lockedActiveAdminCount(): Int =
        Users.selectAll()
            .where { (Users.role eq UserRole.ADMIN.name) and Users.active() }
            .forUpdate()
            .toList()
            .size
}
