import { useQuery } from "@tanstack/react-query";
import { listPublicHolidays, type PublicHoliday } from "../api/calendar";

/** The query key of the dictionary: a holiday mutation refreshes the `["calendar"]` prefix. */
export const HOLIDAYS_QUERY_KEY = ["calendar", "holidays"] as const;

/** Stable between renders while the data is, so a consumer can hand it straight to the Timeline. */
const NONE: readonly PublicHoliday[] = [];

/**
 * The dictionary changes when an ADMIN edits it (that mutation refreshes the cache on the admin's own client); another admin's edit reaches
 * this client on the next refetch, so the copy is trusted for a minute only.
 */
const STALE_MS = 60 * 1000;

/** What {@link useHolidays} answers: the rows, and whether the dictionary is missing because its load failed. */
export type Holidays = { holidays: readonly PublicHoliday[]; failed: boolean };

/**
 * The public holidays, date order, as ONE cached query every timeline page and the schedule dialog share. Never blocks a page: while it
 * loads — or if it failed — the list is empty and the figures simply show no holiday (the server's views are the authority). `failed` is
 * true only when there is NO dictionary to show (a failed refetch keeps the last copy), so a page can say the holidays are not drawn.
 */
export function useHolidays(): Holidays {
  const { data, isError } = useQuery({ queryKey: HOLIDAYS_QUERY_KEY, queryFn: listPublicHolidays, staleTime: STALE_MS });
  return { holidays: data ?? NONE, failed: isError && data === undefined };
}
