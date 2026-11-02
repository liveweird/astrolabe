-- Baselines (v0.9.0): a named, IMMUTABLE copy of the plan's dated structure taken at one plan revision, compared against the live plan by a
-- pure kernel. `baselines` is the header: a soft-deleted business entity (the name frees on delete through the partial unique index) that
-- records the plan revision it EQUALS (the one its creation left behind: revision + 1 under the plan_state lock). `baseline_projects` and
-- `baseline_milestones` are the FROZEN rows (a new category in persistence.md "Soft delete"): never updated or deleted - the triggers at
-- the end enforce it at the database (UPDATE, DELETE and TRUNCATE), Flow's metrics.forbid_snapshot_change (V16) ported without its
-- purge bypass - and kept for a soft-deleted baseline too. The header is guarded too: it is never hard-deleted, and the columns that
-- say WHAT was captured (id, plan_revision, created_by_user_id, the counts, created_at) never change; only the name, the description,
-- updated_at and the soft-delete flag are writable. They carry NO foreign key to a live row (milestones, projects, teams, programs, work streams): a frozen copy
-- reads the same whatever happens to the live row afterwards, and an FK would only add FOR KEY SHARE traffic on every parent per create.
-- Their ids are plain INTEGER columns holding the live ids as they were. Every write runs under the plan_state lock (V12).
CREATE TABLE baselines (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(500) NULL,
    plan_revision BIGINT NOT NULL,                 -- the plan revision this baseline EQUALS (the one its creation left behind)
    created_by_user_id BIGINT NULL REFERENCES users(id),
    milestone_count INTEGER NOT NULL CHECK (milestone_count >= 0),
    project_count INTEGER NOT NULL CHECK (project_count >= 0),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    marked_as_deleted BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX uq_baselines_name_active ON baselines (LOWER(name)) WHERE NOT marked_as_deleted;
CREATE INDEX idx_baselines_marked_as_deleted ON baselines (marked_as_deleted);

CREATE TABLE baseline_projects (                  -- a frozen copy: no FK to the live rows (see the header)
    baseline_id INTEGER NOT NULL REFERENCES baselines(id),
    project_id INTEGER NOT NULL,
    program_id INTEGER NOT NULL,
    work_stream_id INTEGER NOT NULL,
    name VARCHAR(100) NOT NULL,
    program_name VARCHAR(100) NOT NULL,
    work_stream_name VARCHAR(100) NOT NULL,
    rank_position INTEGER NULL CHECK (rank_position >= 1),
    target_start DATE NULL, target_end DATE NULL,
    span_start DATE NULL, span_end DATE NULL,        -- the derived span at baseline time (SpanKernels.derivedSpan)
    PRIMARY KEY (baseline_id, project_id),
    CONSTRAINT ck_baseline_projects_target CHECK ((target_start IS NULL) = (target_end IS NULL)),
    CONSTRAINT ck_baseline_projects_target_order CHECK (target_end >= target_start),
    CONSTRAINT ck_baseline_projects_span CHECK ((span_start IS NULL) = (span_end IS NULL)),
    CONSTRAINT ck_baseline_projects_span_order CHECK (span_end >= span_start)
);

CREATE TABLE baseline_milestones (
    baseline_id INTEGER NOT NULL REFERENCES baselines(id),
    milestone_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    name VARCHAR(100) NOT NULL,
    estimate_md NUMERIC(8,2) NOT NULL CHECK (estimate_md >= 0),
    start_date DATE NULL, end_date DATE NULL,
    PRIMARY KEY (baseline_id, milestone_id),
    CONSTRAINT ck_baseline_milestones_schedule CHECK ((start_date IS NULL) = (end_date IS NULL)),
    CONSTRAINT ck_baseline_milestones_schedule_order CHECK (end_date >= start_date)
);
CREATE INDEX idx_baseline_milestones_team ON baseline_milestones (baseline_id, team_id);
CREATE INDEX idx_baseline_milestones_project ON baseline_milestones (baseline_id, project_id);

-- Flow's metrics.forbid_snapshot_change (V16) ported: the snapshot rows are frozen at the database; nothing purges them (a purge adds its bypass GUC in its own migration).
CREATE FUNCTION forbid_baseline_row_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'baseline rows are frozen (% on %)', TG_OP, TG_TABLE_NAME; END $$;
CREATE TRIGGER trg_baseline_projects_frozen BEFORE UPDATE OR DELETE ON baseline_projects FOR EACH ROW EXECUTE FUNCTION forbid_baseline_row_change();
CREATE TRIGGER trg_baseline_milestones_frozen BEFORE UPDATE OR DELETE ON baseline_milestones FOR EACH ROW EXECUTE FUNCTION forbid_baseline_row_change();
-- A row trigger does not fire on TRUNCATE: the statement-level twins close that door on the frozen tables and on the header.
CREATE TRIGGER trg_baseline_projects_no_truncate BEFORE TRUNCATE ON baseline_projects FOR EACH STATEMENT EXECUTE FUNCTION forbid_baseline_row_change();
CREATE TRIGGER trg_baseline_milestones_no_truncate BEFORE TRUNCATE ON baseline_milestones FOR EACH STATEMENT EXECUTE FUNCTION forbid_baseline_row_change();
CREATE TRIGGER trg_baselines_no_truncate BEFORE TRUNCATE ON baselines FOR EACH STATEMENT EXECUTE FUNCTION forbid_baseline_row_change();

-- The header: soft delete only, and the capture facts are fixed at creation. IS DISTINCT FROM so a NULL created_by_user_id compares sanely.
CREATE FUNCTION forbid_baseline_header_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'baselines are soft-deleted only (DELETE on %)', TG_TABLE_NAME;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.plan_revision IS DISTINCT FROM OLD.plan_revision
        OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
        OR NEW.milestone_count IS DISTINCT FROM OLD.milestone_count
        OR NEW.project_count IS DISTINCT FROM OLD.project_count
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'baseline header columns are frozen (UPDATE on %)', TG_TABLE_NAME;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_baselines_header_frozen BEFORE UPDATE OR DELETE ON baselines FOR EACH ROW EXECUTE FUNCTION forbid_baseline_header_change();
