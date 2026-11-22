-- A Flow document's 2,000-sprint cap is global, so a returned team's omitted sprint is unknown rather than gone. Existing mirror rows
-- predate this evidence and therefore start conservatively incomplete; the next complete Flow refresh marks each returned team complete.
ALTER TABLE flow_teams
    ADD COLUMN sprints_complete BOOLEAN NOT NULL DEFAULT FALSE;
