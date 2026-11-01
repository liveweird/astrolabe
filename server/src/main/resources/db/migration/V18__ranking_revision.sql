-- The ranking's own revision (v0.5.0): the plan revision at which roadmap_entries was last written. PUT /roadmap/ranking compares its
-- expectedRevision against THIS counter instead of plan_state.revision, so a plan write elsewhere (a milestone, a dependency, a rename)
-- never makes a rank edit stale. Stamped with the new plan revision by every accepted ranking PUT and by a project delete that compacts
-- the rank; GET /views/roadmap answers it as `revision`. Seeded from the current plan revision, so a client holding the latest
-- pre-upgrade view is not refused.
ALTER TABLE plan_state ADD COLUMN ranking_revision BIGINT NOT NULL DEFAULT 0;
UPDATE plan_state SET ranking_revision = revision WHERE id = 1;
