-- Team capacity periods (v0.5.0): a team's man-days per week, and optionally a work-in-progress limit, from an effective-from date.
-- effective_from is any calendar day; a period is in force until the next ACTIVE period's effective_from of the same team. The
-- proration and WIP rules that read these rows are in .claude/docs/planning-model.md "Team capacity periods". Rows are soft-deleted
-- like every business entity, and a team delete soft-deletes its periods.
CREATE TABLE team_capacity_periods (
    id SERIAL PRIMARY KEY,
    -- No ON DELETE rule: teams are soft-deleted only.
    team_id INTEGER NOT NULL REFERENCES teams(id),
    effective_from DATE NOT NULL,
    -- NUMERIC(8,2) like milestones.estimate_md: validated to two decimals, so the stored value is exactly the sent one. Zero = on hold.
    md_per_week NUMERIC(8,2) NOT NULL,
    -- NULL = no limit.
    wip_limit INTEGER,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    marked_as_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT ck_team_capacity_periods_md CHECK (md_per_week >= 0),
    -- The backstop of the validator's "wipLimit must be between 1 and 99".
    CONSTRAINT ck_team_capacity_periods_wip CHECK (wip_limit IS NULL OR wip_limit BETWEEN 1 AND 99)
);
-- One ACTIVE period per team and start date; a deleted period frees its date. Also serves the per-team reads of active rows.
CREATE UNIQUE INDEX uq_team_capacity_periods_team_from_active
    ON team_capacity_periods (team_id, effective_from) WHERE NOT marked_as_deleted;
