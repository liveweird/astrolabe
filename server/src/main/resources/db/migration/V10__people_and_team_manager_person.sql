-- The people directory (v0.2.0): the people who own plan nodes and manage teams. A person is NOT a login: `user_id` links the
-- optional Astrolabe account, set by an ADMIN (the person-to-user link, `planning-model.md`); an external owner has none.
-- Soft-deleted like every business entity; names are not unique (two real "Anna Nowak"s), the optional email and the login
-- link are, among ACTIVE people only (the V6 partial-index shape).
CREATE TABLE people (
    id SERIAL PRIMARY KEY,
    "name" VARCHAR(100) NOT NULL,
    email VARCHAR(254) NULL,
    -- The optional login (users.id is BIGSERIAL, hence BIGINT). No ON DELETE rule: users are only ever soft-deleted; a
    -- soft-deleted user's id stays here, inert (readers resolve the login through ACTIVE users).
    user_id BIGINT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    marked_as_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX uq_people_email_active ON people (LOWER(email)) WHERE NOT marked_as_deleted AND email IS NOT NULL;
CREATE UNIQUE INDEX uq_people_user_id_active ON people (user_id) WHERE NOT marked_as_deleted AND user_id IS NOT NULL;

-- A team's manager becomes a person (V6 pointed at a user). The old column is backfilled, then dropped.
ALTER TABLE teams ADD COLUMN manager_person_id INTEGER NULL REFERENCES people(id);

-- One person per ACTIVE user who manages an ACTIVE team today (name copied from the user, the login linked, the email lower-cased as
-- the application stores it). A soft-deleted manager already read as "no manager" and stays unset, and so does a deleted team's.
-- users.email is unique only as typed, while people.email is unique case-insensitively: when two such users differ only in case,
-- the later one gets no email rather than aborting the migration. One timestamp per row.
INSERT INTO people ("name", email, user_id, created_at, updated_at)
SELECT u."name",
       CASE WHEN ROW_NUMBER() OVER (PARTITION BY LOWER(u.email) ORDER BY u.id) = 1 THEN LOWER(u.email) END,
       u.id, n.ts, n.ts
FROM users u
CROSS JOIN LATERAL (SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT AS ts) n
WHERE NOT u.marked_as_deleted
  AND u.id IN (SELECT manager_user_id FROM teams WHERE manager_user_id IS NOT NULL AND NOT marked_as_deleted);

UPDATE teams t SET manager_person_id = p.id
FROM people p
WHERE p.user_id = t.manager_user_id AND NOT p.marked_as_deleted AND NOT t.marked_as_deleted;

-- Dropping the column drops idx_teams_manager_user_id with it.
ALTER TABLE teams DROP COLUMN manager_user_id;
CREATE INDEX idx_teams_manager_person_id ON teams(manager_person_id);
