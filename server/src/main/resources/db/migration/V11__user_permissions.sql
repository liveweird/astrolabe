-- Per-user permissions (v0.2.0): a GRANT set, the opposite polarity of the V5 disabled-feature set. A row means the user
-- holds the permission; no row means they do not, so the empty table needs no backfill and every existing/new user starts
-- with none. The first (and so far only) permission is ROADMAP_EDITOR: ranking the projects and setting a project's target
-- window without owning it. Read from this table in the database on EVERY request (UserService.hasPermission), never from
-- a JWT claim, so a grant or a revoke takes effect on the very next request. No CHECK on permission: the application enum
-- is the whitelist, so a future permission needs no migration (the V5 precedent). The index backs "who holds P" reads.
CREATE TABLE user_permissions (
    user_id BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(30) NOT NULL,
    PRIMARY KEY (user_id, permission)
);
CREATE INDEX idx_user_permissions_permission ON user_permissions(permission);
