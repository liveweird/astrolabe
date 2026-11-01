-- Dependencies (v0.4.0): a link between two endpoints, each a milestone OR a project (exactly one id column per side), within or
-- across projects. The SUCCESSOR is the constrained side ("the successor waits for the predecessor"). A dependency never moves a
-- date. The ACTIVE rows are kept acyclic on the start/end time-point graph by the service (no constraint can express it).
-- Soft-deleted like every plan entity; a milestone or project delete soft-deletes its links in the same transaction.
CREATE TABLE dependencies (
    id SERIAL PRIMARY KEY,
    -- No ON DELETE rules: milestones and projects are soft-deleted only, and their deletes cascade here in the same transaction.
    pred_milestone_id INTEGER NULL REFERENCES milestones(id),
    pred_project_id INTEGER NULL REFERENCES projects(id),
    succ_milestone_id INTEGER NULL REFERENCES milestones(id),
    succ_project_id INTEGER NULL REFERENCES projects(id),
    -- FS / SS / FF / SF: the Kotlin DependencyType enum is the whitelist, the CHECK the backstop.
    "type" VARCHAR(2) NOT NULL,
    -- Working days (Monday-Friday until the v0.7 calendar); negative = a lead.
    lag_days INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    marked_as_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT ck_dependencies_pred CHECK (num_nonnulls(pred_milestone_id, pred_project_id) = 1),
    CONSTRAINT ck_dependencies_succ CHECK (num_nonnulls(succ_milestone_id, succ_project_id) = 1),
    CONSTRAINT ck_dependencies_type CHECK ("type" IN ('FS', 'SS', 'FF', 'SF')),
    CONSTRAINT ck_dependencies_lag CHECK (lag_days BETWEEN -365 AND 365),
    -- A NULL comparison passes a CHECK, so the mixed cases (a milestone linked to a project) pass; only the same id on both sides fails.
    CONSTRAINT ck_dependencies_not_self CHECK (
        (pred_milestone_id IS NULL OR pred_milestone_id <> succ_milestone_id)
        AND (pred_project_id IS NULL OR pred_project_id <> succ_project_id)
    )
);
-- One ACTIVE link per ordered pair of endpoints, whatever its type. NULLS NOT DISTINCT: the unused id column of each side is NULL and
-- must still collide. A deleted link frees the pair.
CREATE UNIQUE INDEX uq_dependencies_pair_active
    ON dependencies (pred_milestone_id, pred_project_id, succ_milestone_id, succ_project_id) NULLS NOT DISTINCT
    WHERE NOT marked_as_deleted;
CREATE INDEX idx_dependencies_pred_milestone ON dependencies(pred_milestone_id);
CREATE INDEX idx_dependencies_succ_milestone ON dependencies(succ_milestone_id);
CREATE INDEX idx_dependencies_pred_project ON dependencies(pred_project_id);
CREATE INDEX idx_dependencies_succ_project ON dependencies(succ_project_id);
