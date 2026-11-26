-- 1.29: a colour for every team, one key of a fixed palette of twelve (teams/TeamColour.kt, .claude/docs/team-colours.md). The keys are
-- stored by name and never renamed or removed; the palette order is the assignment order. Existing teams are backfilled distinct up to
-- twelve, the ACTIVE ones first (by id), then the soft-deleted ones; a thirteenth team shares the first colour again.
-- The DEFAULT stays on purpose: a build that does not know the column (a rollback past this migration) can still insert a team.
ALTER TABLE teams ADD COLUMN colour VARCHAR(16) NOT NULL DEFAULT 'INDIGO';
UPDATE teams SET colour = (ARRAY['INDIGO','TEAL','LIME','RASPBERRY','GRAPE','PINK','VIOLET','COBALT','AZURE','LAVENDER','SAPPHIRE','GREEN'])[1 + (ranked.n - 1) % 12]
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY marked_as_deleted, id) AS n FROM teams) ranked WHERE teams.id = ranked.id;
ALTER TABLE teams ADD CONSTRAINT ck_teams_colour CHECK (colour IN ('INDIGO','TEAL','LIME','RASPBERRY','GRAPE','PINK','VIOLET','COBALT','AZURE','LAVENDER','SAPPHIRE','GREEN'));
