-- The team milestone order (v0.5.0): per team, positions for milestones. team_milestone_orders holds at most one row per milestone, with
-- positions from 1 per team; it is a hard-delete position join like roadmap_entries (persistence.md "Soft delete"). What the rows mean and
-- how they are written and read is in .claude/docs/planning-model.md "The team milestone order".
CREATE TABLE team_milestone_orders (
    -- No ON DELETE rules: milestones and teams are soft-deleted only.
    milestone_id INTEGER PRIMARY KEY REFERENCES milestones(id),
    team_id INTEGER NOT NULL REFERENCES teams(id),
    position INTEGER NOT NULL CHECK (position >= 1),
    -- DEFERRABLE INITIALLY DEFERRED: a renumbering is one UPDATE statement, which an immediate unique check can reject mid-statement,
    -- depending on the physical row order (the V13 reasoning).
    -- Its index also serves every per-team read, so there is no separate team_id index.
    CONSTRAINT uq_team_milestone_orders_position UNIQUE (team_id, position) DEFERRABLE INITIALLY DEFERRED
);
-- Per team, a revision number (a plan revision) for its order.
CREATE TABLE team_order_state (
    team_id INTEGER PRIMARY KEY REFERENCES teams(id),
    revision BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
