-- Milestones (v0.3.0): the fourth level of the plan, under a project. A milestone has exactly one team and NO owner; its plan
-- fields are edited by the owner chain of its project, its dates ONLY by the team's manager or ADMIN (PUT /milestones/{id}/schedule).
-- Null dates = unscheduled (the Unscheduled tray); both set or both null; inclusive, end not before start.
CREATE TABLE milestones (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    -- Exactly one team; no ON DELETE: teams are soft-deleted only and TeamService.delete refuses (409) while an ACTIVE milestone names the team.
    team_id INTEGER NOT NULL REFERENCES teams(id),
    "name" VARCHAR(100) NOT NULL,
    description VARCHAR(500),
    -- Man-days, two decimals (quarter days fit); zero is a zero-effort checkpoint. The v0.5 load kernel spreads it over the span's working days.
    estimate_md NUMERIC(8, 2) NOT NULL,
    start_date DATE NULL,
    end_date DATE NULL,
    -- The plan revision at which the schedule (including its initial empty state) was last written: the per-milestone staleness
    -- check of PUT /milestones/{id}/schedule — a client's expectedRevision below it is a 409, unrelated plan writes never stale a drag.
    schedule_revision BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    marked_as_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT ck_milestones_estimate CHECK (estimate_md >= 0),
    CONSTRAINT ck_milestones_schedule CHECK ((start_date IS NULL) = (end_date IS NULL)),
    CONSTRAINT ck_milestones_schedule_order CHECK (start_date IS NULL OR end_date >= start_date)
);
CREATE UNIQUE INDEX uq_milestones_project_name_active ON milestones (project_id, LOWER("name")) WHERE NOT marked_as_deleted;
CREATE INDEX idx_milestones_project ON milestones(project_id);
CREATE INDEX idx_milestones_team ON milestones(team_id);
