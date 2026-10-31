-- Flat teams (Lettuce's V2 minus the management chain: a team has at most ONE optional manager, no succession history):
-- a team is a name plus a description, the ownership unit future features scope to. There is deliberately no roster table
-- (Flow's V6 `team_members` was dropped in Flow V30 because nothing read it).
CREATE TABLE teams (
    id SERIAL PRIMARY KEY,
    "name" VARCHAR(100) NOT NULL,
    description VARCHAR(500),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    marked_as_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    -- The team's optional manager - an Astrolabe login (users.id is BIGSERIAL, hence BIGINT). At most one per team, one user
    -- may manage several teams. A soft-deleted user's id may linger here: readers resolve the manager through ACTIVE users and
    -- read a deleted one as "no manager" (soft-delete-safe by construction). Folded in from Flow's V23.
    manager_user_id BIGINT NULL REFERENCES users(id)
);

-- Name uniqueness among ACTIVE teams only, case-insensitively (the soft-delete convention:
-- a deleted team frees its name; "Payments" next to "payments" would be a confusing twin).
CREATE UNIQUE INDEX uq_teams_name_active ON teams (LOWER("name")) WHERE NOT marked_as_deleted;
CREATE INDEX idx_teams_manager_user_id ON teams(manager_user_id);
