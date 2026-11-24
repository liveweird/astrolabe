-- 1.26: a baseline also freezes the plan's LINKS and the teams' CAPACITY PERIODS (V20 froze only the dated structure). `baseline_dependencies`
-- is every ACTIVE link as it was (the four end ids, type, lag) and `baseline_capacity_periods` every ACTIVE period of every ACTIVE team,
-- both captured in the same plan-locked transaction as V20's rows. Like them they are FROZEN (row and TRUNCATE triggers, the V20
-- function) and hold NO foreign key to a live row (the ids are the live ids as they were); the CHECKs mirror V15 and V16.
-- A baseline taken before this migration (or by a build that does not know it) has NULL counts: NULL = "not captured", which the
-- comparison reads as unknown, never as "no links" - so a 1.25 build running on this schema still writes valid headers (NULLs) and rows
-- of the two old tables, and nothing here needs undoing. Both counts are set together (ck_baselines_capture_counts).
ALTER TABLE baselines
    ADD COLUMN dependency_count INTEGER NULL CONSTRAINT ck_baselines_dependency_count CHECK (dependency_count >= 0),
    ADD COLUMN capacity_period_count INTEGER NULL CONSTRAINT ck_baselines_capacity_period_count CHECK (capacity_period_count >= 0),
    ADD CONSTRAINT ck_baselines_capture_counts CHECK ((dependency_count IS NULL) = (capacity_period_count IS NULL));

CREATE TABLE baseline_dependencies (
    baseline_id INTEGER NOT NULL REFERENCES baselines(id),
    dependency_id INTEGER NOT NULL,
    pred_milestone_id INTEGER NULL,
    pred_project_id INTEGER NULL,
    succ_milestone_id INTEGER NULL,
    succ_project_id INTEGER NULL,
    "type" VARCHAR(2) NOT NULL,
    lag_days INTEGER NOT NULL,
    PRIMARY KEY (baseline_id, dependency_id),
    CONSTRAINT ck_baseline_dependencies_pred CHECK (num_nonnulls(pred_milestone_id, pred_project_id) = 1),
    CONSTRAINT ck_baseline_dependencies_succ CHECK (num_nonnulls(succ_milestone_id, succ_project_id) = 1),
    CONSTRAINT ck_baseline_dependencies_type CHECK ("type" IN ('FS', 'SS', 'FF', 'SF')),
    CONSTRAINT ck_baseline_dependencies_lag CHECK (lag_days BETWEEN -365 AND 365)
);

CREATE TABLE baseline_capacity_periods (
    baseline_id INTEGER NOT NULL REFERENCES baselines(id),
    period_id INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    effective_from DATE NOT NULL,
    md_per_week NUMERIC(8,2) NOT NULL CHECK (md_per_week >= 0),
    wip_limit INTEGER NULL CONSTRAINT ck_baseline_capacity_periods_wip CHECK (wip_limit IS NULL OR wip_limit BETWEEN 1 AND 99),
    PRIMARY KEY (baseline_id, period_id)
);
CREATE INDEX idx_baseline_capacity_periods_team ON baseline_capacity_periods (baseline_id, team_id);

CREATE TRIGGER trg_baseline_dependencies_frozen BEFORE UPDATE OR DELETE ON baseline_dependencies FOR EACH ROW EXECUTE FUNCTION forbid_baseline_row_change();
CREATE TRIGGER trg_baseline_capacity_periods_frozen BEFORE UPDATE OR DELETE ON baseline_capacity_periods FOR EACH ROW EXECUTE FUNCTION forbid_baseline_row_change();
CREATE TRIGGER trg_baseline_dependencies_no_truncate BEFORE TRUNCATE ON baseline_dependencies FOR EACH STATEMENT EXECUTE FUNCTION forbid_baseline_row_change();
CREATE TRIGGER trg_baseline_capacity_periods_no_truncate BEFORE TRUNCATE ON baseline_capacity_periods FOR EACH STATEMENT EXECUTE FUNCTION forbid_baseline_row_change();

-- V20's header guard, replaced (V20's bytes stay): the two new counts join the columns that never change. The trigger keeps pointing at it.
CREATE OR REPLACE FUNCTION forbid_baseline_header_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'baselines are soft-deleted only (DELETE on %)', TG_TABLE_NAME;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.plan_revision IS DISTINCT FROM OLD.plan_revision
        OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
        OR NEW.milestone_count IS DISTINCT FROM OLD.milestone_count
        OR NEW.project_count IS DISTINCT FROM OLD.project_count
        OR NEW.dependency_count IS DISTINCT FROM OLD.dependency_count
        OR NEW.capacity_period_count IS DISTINCT FROM OLD.capacity_period_count
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'baseline header columns are frozen (UPDATE on %)', TG_TABLE_NAME;
    END IF;
    RETURN NEW;
END $$;
