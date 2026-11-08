-- Flow sync (v1.5.0): the connection registry for Flow (the sibling app), a wholesale-replaced MIRROR of the one document its read-only
-- service token returns (teams, their sprints, their dated members), the 1:1 bindings of an Astrolabe team to a Flow team, and the
-- provenance of a capacity period (hand-entered or imported from a Flow sprint). Nothing here ever writes to Flow.

-- A Flow connection. Soft-deleted (the name frees on delete). api_token holds a FieldCipher envelope ('enc:v1:...'), write-only end to end;
-- a delete sets it NULL (no dormant credential). base_url is an exact origin the operator listed (FLOW_ALLOWED_HOSTS / FLOW_INSECURE_ORIGINS):
-- the connection's identity, so a PUT never changes it. time_zone (an IANA id) turns Flow's sprint and membership instants into dates.
-- teams_at is the instant the last run replaced the mirror (null = never).
CREATE TABLE flow_connections (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    base_url VARCHAR(255) NOT NULL,
    time_zone VARCHAR(64) NOT NULL,
    api_token TEXT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    -- Minutes between scheduled runs; NULL = manual only. No DEFAULT: the registry writes the interval it was given (60 when omitted).
    poll_interval_minutes INTEGER NULL,
    last_tested_at BIGINT NULL,
    last_test_ok BOOLEAN NULL,
    teams_at BIGINT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    marked_as_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    -- The token is only ever stored as an envelope; a delete overwrites it with NULL, and only a deleted row may hold NULL (V21's two CHECKs).
    CONSTRAINT ck_flow_connections_api_token CHECK (api_token IS NULL OR api_token LIKE 'enc:v1:%'),
    CONSTRAINT ck_flow_connections_api_token_live CHECK (marked_as_deleted OR api_token IS NOT NULL),
    CONSTRAINT ck_flow_connections_poll_interval CHECK (poll_interval_minutes IS NULL OR poll_interval_minutes BETWEEN 5 AND 1440)
);
CREATE UNIQUE INDEX uq_flow_connections_name_active ON flow_connections (LOWER(name)) WHERE NOT marked_as_deleted;

-- The mirror: the latest observed document of a connection, REPLACED WHOLESALE by every run in one transaction and hard-deleted with the
-- connection (the jira_issues class of exception, persistence.md "Soft delete"). Instants are Flow's raw epoch millis; the zone is applied at
-- read time. No foreign key between the three tables: a run replaces them together, and a team's rows are read by (connection_id, flow_team_id).
CREATE TABLE flow_teams (
    connection_id INTEGER NOT NULL REFERENCES flow_connections(id),
    flow_team_id INTEGER NOT NULL,
    name VARCHAR(100) NOT NULL,
    default_capacity_md NUMERIC(8,2) NULL,
    observed_at BIGINT NOT NULL,
    PRIMARY KEY (connection_id, flow_team_id)
);
-- sprint_id is Flow's; source_connection_id is the id of the data-source connection INSIDE Flow the sprint came from (Flow's `connectionId`; a sprint id is unique per it).
CREATE TABLE flow_sprints (
    connection_id INTEGER NOT NULL REFERENCES flow_connections(id),
    flow_team_id INTEGER NOT NULL,
    sprint_id BIGINT NOT NULL,
    source_connection_id INTEGER NOT NULL,
    name VARCHAR(255) NOT NULL,
    state VARCHAR(10) NOT NULL,
    start_at BIGINT NULL,
    end_at BIGINT NULL,
    complete_at BIGINT NULL,
    has_calendar BOOLEAN NOT NULL,
    capacity_md NUMERIC(10,2) NULL,
    capacity_source VARCHAR(20) NULL,
    PRIMARY KEY (connection_id, flow_team_id, sprint_id)
);
CREATE INDEX ix_flow_sprints_team ON flow_sprints (connection_id, flow_team_id, start_at);
-- A member is a Jira account of the team over a dated interval (valid_to NULL = still a member). account_id never leaves the server.
CREATE TABLE flow_members (
    connection_id INTEGER NOT NULL REFERENCES flow_connections(id),
    flow_team_id INTEGER NOT NULL,
    account_id VARCHAR(128) NOT NULL,
    display_name VARCHAR(255) NULL,
    valid_from BIGINT NOT NULL,
    valid_to BIGINT NULL,
    PRIMARY KEY (connection_id, flow_team_id, account_id, valid_from)
);

-- A binding links ONE Astrolabe team to ONE Flow team of a connection. Soft-deleted = unlinked; the row stays as history. flow_team_name is
-- the name when it was linked (display only; the binding follows flow_team_id). No ON DELETE rules: teams, users and connections are only
-- soft-deleted. Both indexes are partial over the ACTIVE rows: a team has at most one Flow team across all connections, and a Flow team of
-- a connection at most one team.
CREATE TABLE flow_team_bindings (
    id SERIAL PRIMARY KEY,
    connection_id INTEGER NOT NULL REFERENCES flow_connections(id),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    flow_team_id INTEGER NOT NULL,
    flow_team_name VARCHAR(100) NOT NULL,
    created_by_user_id BIGINT NOT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    marked_as_deleted BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX uq_flow_team_bindings_team_active ON flow_team_bindings (team_id) WHERE NOT marked_as_deleted;
CREATE UNIQUE INDEX uq_flow_team_bindings_flow_active ON flow_team_bindings (connection_id, flow_team_id) WHERE NOT marked_as_deleted;

-- Provenance of a capacity period: MANUAL (every existing row and every hand-entered one) or FLOW (written by the capacity import for the
-- sprint named here). A manual edit of a FLOW row turns it MANUAL and clears the sprint columns; the import never touches a MANUAL row.
ALTER TABLE team_capacity_periods
    ADD COLUMN source VARCHAR(10) NOT NULL DEFAULT 'MANUAL' CONSTRAINT ck_team_capacity_periods_source CHECK (source IN ('MANUAL', 'FLOW')),
    ADD COLUMN flow_sprint_id BIGINT NULL,
    ADD COLUMN flow_sprint_name VARCHAR(255) NULL,
    -- A FLOW period names its sprint (id and name); a MANUAL one names none.
    ADD CONSTRAINT ck_team_capacity_periods_flow_sprint CHECK (
        (source = 'MANUAL' AND flow_sprint_id IS NULL AND flow_sprint_name IS NULL)
        OR (source = 'FLOW' AND flow_sprint_id IS NOT NULL AND flow_sprint_name IS NOT NULL)
    );
