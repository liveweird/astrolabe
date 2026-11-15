package ch.nokillswit.infra.time

/**
 * Decimal places of a man-day figure: the `NUMERIC(_,2)` columns, the two-decimal rule of `validateManDays`, and every rounding
 * (`HALF_UP`) of an estimate, a capacity or a deviation to the figure the plan stores and shows.
 */
const val MAN_DAY_SCALE = 2
