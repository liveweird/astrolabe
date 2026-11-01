-- The public-holiday dictionary (v0.7.0; Flow's V25 / Lettuce's registry, ported): ADMIN-curated dates on which nobody works, read into
-- the one WorkingCalendar every view and the schedule write use. No seed: the Polish preset endpoint fills a year on request.
-- HARD-DELETE (the registry exception of .claude/docs/persistence.md "Soft delete"): nothing references a holiday by FK, a removed
-- row is simply re-added, and the UNIQUE date must free on delete. Plan state: every write runs under the plan_state lock.
CREATE TABLE public_holidays (
    id SERIAL PRIMARY KEY,
    holiday_date DATE NOT NULL,          -- through infra/db/LocalDateColumn.kt; validated 1900-2999 by parseIsoDate
    name VARCHAR(100) NOT NULL,
    created_at BIGINT NOT NULL,          -- epoch millis
    CONSTRAINT uq_public_holidays_date UNIQUE (holiday_date)
);
