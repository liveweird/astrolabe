-- Jira sync (v1.1.0): the connection registry, the 1:1 bindings of plan nodes to Jira issues, the latest observation per binding and the run
-- registry. Nothing here ever writes to Jira; the sync only OBSERVES and the deviations are computed from these rows.

-- A Jira Cloud connection. Soft-deleted (the name frees on delete). api_token holds a FieldCipher envelope ('enc:v1:...'), write-only end to end.
-- mapping is the canonical mapping document ('{}' = unset); discovery is the last field/issue-type snapshot; cloud_id is persisted by a passing
-- Test connection.
CREATE TABLE jira_connections (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    site_url VARCHAR(253) NOT NULL,
    email VARCHAR(254) NOT NULL,
    api_token TEXT NOT NULL,
    auth_scheme VARCHAR(10) NOT NULL,
    project_keys JSONB NOT NULL,
    cloud_id VARCHAR(36) NULL,
    mapping JSONB NOT NULL DEFAULT '{}',
    discovery JSONB NULL,
    discovered_at BIGINT NULL,
    last_tested_at BIGINT NULL,
    last_test_ok BOOLEAN NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    marked_as_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT ck_jira_connections_auth_scheme CHECK (auth_scheme IN ('BASIC', 'BEARER')),
    CONSTRAINT ck_jira_connections_project_keys CHECK (jsonb_typeof(project_keys) = 'array' AND jsonb_array_length(project_keys) BETWEEN 1 AND 50),
    CONSTRAINT ck_jira_connections_mapping CHECK (jsonb_typeof(mapping) = 'object')
);
CREATE UNIQUE INDEX uq_jira_connections_name_active ON jira_connections (LOWER(name)) WHERE NOT marked_as_deleted;
CREATE INDEX idx_jira_connections_marked_as_deleted ON jira_connections (marked_as_deleted);

-- A binding links ONE plan node (program, project or milestone) to ONE Jira issue of a connection. Soft-deleted = unbound; the row stays as history.
-- jira_issue_id is the numeric id (keys change when an issue moves project). No ON DELETE rules: programs, projects and milestones are only
-- soft-deleted. Both uniqueness indexes are partial over the ACTIVE rows, so a node and an issue each carry at most one active binding.
-- NULLS NOT DISTINCT: the two unused node columns are NULL and must still collide.
CREATE TABLE jira_bindings (
    id SERIAL PRIMARY KEY,
    connection_id INTEGER NOT NULL REFERENCES jira_connections(id),
    level VARCHAR(10) NOT NULL,
    program_id INTEGER NULL REFERENCES programs(id),
    project_id INTEGER NULL REFERENCES projects(id),
    milestone_id INTEGER NULL REFERENCES milestones(id),
    jira_issue_id VARCHAR(20) NOT NULL,
    jira_issue_key VARCHAR(50) NOT NULL,
    created_by_user_id BIGINT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    marked_as_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT ck_jira_bindings_level CHECK (level IN ('PROGRAM', 'PROJECT', 'MILESTONE')),
    -- Exactly one node column is set, and it is the one the level names.
    CONSTRAINT ck_jira_bindings_node CHECK (
        num_nonnulls(program_id, project_id, milestone_id) = 1
        AND ((level = 'PROGRAM' AND program_id IS NOT NULL)
            OR (level = 'PROJECT' AND project_id IS NOT NULL)
            OR (level = 'MILESTONE' AND milestone_id IS NOT NULL))
    )
);
CREATE UNIQUE INDEX uq_jira_bindings_node_active
    ON jira_bindings (program_id, project_id, milestone_id) NULLS NOT DISTINCT
    WHERE NOT marked_as_deleted;
CREATE UNIQUE INDEX uq_jira_bindings_issue_active
    ON jira_bindings (connection_id, jira_issue_id)
    WHERE NOT marked_as_deleted;
CREATE INDEX idx_jira_bindings_program ON jira_bindings (program_id);
CREATE INDEX idx_jira_bindings_project ON jira_bindings (project_id);
CREATE INDEX idx_jira_bindings_milestone ON jira_bindings (milestone_id);

-- The latest observed state of a bound issue: one row per binding, overwritten by every run (history is not kept). Hard-delete table.
-- gone/gone_reason say the issue could not be read (DELETED, OUT_OF_SCOPE, FORBIDDEN). Jira's own dates are stored as observed, so no
-- start/end order CHECK.
CREATE TABLE jira_observations (
    binding_id INTEGER PRIMARY KEY REFERENCES jira_bindings(id),
    observed_at BIGINT NOT NULL,
    issue_key VARCHAR(50) NULL,
    summary VARCHAR(255) NULL,
    type_id VARCHAR(20) NULL,
    type_name VARCHAR(100) NULL,
    hierarchy_level INTEGER NULL,
    status_name VARCHAR(100) NULL,
    status_category VARCHAR(16) NULL,
    parent_issue_id VARCHAR(20) NULL,
    parent_issue_key VARCHAR(50) NULL,
    start_date DATE NULL,
    end_date DATE NULL,
    estimate NUMERIC(12,2) NULL,
    estimate_unit VARCHAR(8) NULL,
    team_name VARCHAR(100) NULL,
    jira_updated_at BIGINT NULL,
    gone BOOLEAN NOT NULL DEFAULT FALSE,
    gone_reason VARCHAR(20) NULL,
    CONSTRAINT ck_jira_observations_status_category CHECK (status_category IN ('TODO', 'IN_PROGRESS', 'DONE', 'UNKNOWN')),
    CONSTRAINT ck_jira_observations_gone_reason CHECK (gone_reason IN ('DELETED', 'OUT_OF_SCOPE', 'FORBIDDEN'))
);

-- One row per run of a connector. Hard-delete by retention (the last 50 per connection, pruned at claim time). connection_id has no FK: kind
-- decides which table it names. error_detail never holds a URL with a query or a token.
-- uq_sync_runs_running is the single-writer claim: at most one unfinished run per (kind, connection).
CREATE TABLE sync_runs (
    id SERIAL PRIMARY KEY,
    kind VARCHAR(10) NOT NULL,
    connection_id INTEGER NOT NULL,
    "trigger" VARCHAR(10) NOT NULL,
    requested_by_user_id BIGINT NULL,
    started_at BIGINT NOT NULL,
    finished_at BIGINT NULL,
    outcome VARCHAR(12) NULL,
    error_code VARCHAR(40) NULL,
    error_detail VARCHAR(500) NULL,
    observed_count INTEGER NOT NULL DEFAULT 0,
    gone_count INTEGER NOT NULL DEFAULT 0,
    call_count INTEGER NOT NULL DEFAULT 0,
    rate_limited_count INTEGER NOT NULL DEFAULT 0,
    backoff_ms BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT ck_sync_runs_kind CHECK (kind IN ('JIRA', 'FLOW')),
    CONSTRAINT ck_sync_runs_trigger CHECK ("trigger" IN ('MANUAL', 'SCHEDULED')),
    CONSTRAINT ck_sync_runs_outcome CHECK (outcome IN ('SUCCEEDED', 'FAILED', 'ABANDONED'))
);
CREATE UNIQUE INDEX uq_sync_runs_running ON sync_runs (kind, connection_id) WHERE finished_at IS NULL;
CREATE INDEX idx_sync_runs_connection ON sync_runs (kind, connection_id, started_at DESC);
