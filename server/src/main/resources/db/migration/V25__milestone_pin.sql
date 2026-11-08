-- Milestone pins (v1.7.0): a pinned milestone is FIXED for the auto-proposal (its dates stand, its load is booked, its dates bound its
-- successors). The pin is advice to the planner, not a lock: a drag or the schedule dialog still moves the milestone and keeps the pin;
-- UNSCHEDULING it (the single schedule PUT, the batch accept) clears the pin in the same statement. The proposal is the only reader.
-- The CHECK is the database's half of that rule: a pin needs dates, so a writer of start_date/end_date that forgets to clear the pin
-- fails instead of leaving a pinned, unscheduled row. The pin is NOT frozen into baselines (V20) and is not part of schedule_revision.
-- How it is written and read: .claude/docs/planning-model.md "Milestones" and "The auto-proposal".
ALTER TABLE milestones ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE milestones ADD CONSTRAINT ck_milestones_pinned_scheduled CHECK (NOT pinned OR start_date IS NOT NULL);
