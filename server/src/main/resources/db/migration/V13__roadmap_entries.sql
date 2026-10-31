-- The global project rank (v0.2.0): one row per RANKED project, `position` dense 1..n. A pure position join rewritten wholesale
-- by `PUT /roadmap/ranking` (and compacted when a project is deleted), so it is a HARD-DELETE table like `user_disabled_features`
-- and `user_permissions`: a project the rank leaves has no history to keep. A project with no row here is "unranked". Every
-- write runs under the `plan_state` lock (V12), which also carries the revision the ranking PUT compares.
CREATE TABLE roadmap_entries (
    project_id INTEGER PRIMARY KEY REFERENCES projects(id),
    position INTEGER NOT NULL CHECK (position >= 1),
    -- DEFERRABLE is load-bearing: the renumber after a project delete is one `UPDATE ... SET position = position - 1 WHERE
    -- position > ?`, and a reorder may swap two positions; an immediate unique check can reject either mid-statement, depending
    -- on the physical row order. Deferred, uniqueness is checked once, at commit.
    CONSTRAINT uq_roadmap_entries_position UNIQUE (position) DEFERRABLE INITIALLY DEFERRED
);
