import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { PlanView } from "../api/plan";
import { isSearching, matchCount, NO_FILTER, ownerOptions, type PlanFilter } from "../utils/planTree";
import { activeFilterCount, MAX_QUERY, parsePlanFilter, withPlanFilter } from "../utils/planTreeParams";
import { FILTER_DEBOUNCE_MS } from "./usePagedSort";

/**
 * The Plan page's filters (a name search, one owner, hide closed), which live in the ADDRESS and nowhere else (`utils/planTreeParams.ts`): a change
 * `replace`s the entry, a link shows what its sender saw, a bare visit shows the whole plan, and nothing is remembered. Every other parameter of
 * the address is kept.
 *
 * The search box keeps the text as typed (`typed`, a trailing space included) and writes the trimmed text to the address 300 ms after the last
 * keystroke; an address that changes from outside (Back, a link, Clear filters) replaces the text, during render. A search or owner change is said in
 * the page's polite status ("3 rows match" / "No row matches") while the focus stays where it is. An owner the plan does not hold is ignored (and
 * dropped from the address by the next change). The delayed write goes through the LATEST `setParams`: the updater of one captured at the keystroke
 * would start from that render's address and undo a Hide closed or owner change made within the 300 ms.
 */
export function usePlanFilters(view: PlanView | undefined, announce: (text: string) => void) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const urlFilter = useMemo(() => parsePlanFilter(new URLSearchParams(params.toString())), [params]);
  const owners = useMemo(() => (view === undefined ? [] : ownerOptions(view)), [view]);
  const ownerKnown = view === undefined || owners.some((owner) => owner.id === urlFilter.ownerPersonId);
  const filter: PlanFilter = useMemo(() => (ownerKnown ? urlFilter : { ...urlFilter, ownerPersonId: null }), [urlFilter, ownerKnown]);

  const [typed, setTyped] = useState(urlFilter.q);
  const [seenQ, setSeenQ] = useState(urlFilter.q);
  if (urlFilter.q !== seenQ) {
    setSeenQ(urlFilter.q);
    // The address echoing what was typed (trimmed) must not eat a trailing space; anything else came from outside.
    if (typed.trim() !== urlFilter.q) setTyped(urlFilter.q);
  }

  // The timer fires later than the render that scheduled it: it reads what is true THEN.
  const searchRef = useRef<HTMLInputElement>(null);
  const latest = useRef({ filter, view, setParams, ownerKnown });
  useEffect(() => {
    latest.current = { filter, view, setParams, ownerKnown };
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  /** Writes the change into the address (merged into what it holds now) and, while something is searched, says how many rows match. */
  function commit(change: Partial<PlanFilter>) {
    const { filter: current, view: plan, setParams: write, ownerKnown: known } = latest.current;
    const next = { ...current, ...change };
    write(
      (previous) => {
        const written = parsePlanFilter(previous);
        return withPlanFilter(previous, { ...written, ownerPersonId: known ? written.ownerPersonId : null, ...change });
      },
      { replace: true },
    );
    if (plan === undefined || !isSearching(next)) return;
    const count = matchCount(plan, next);
    announce(count === 0 ? t("plan.filter.none") : t("plan.filter.matches", { count }));
  }

  return {
    filter,
    typed,
    searchRef,
    activeCount: activeFilterCount(filter),
    owners,
    setQuery: (value: string) => {
      setTyped(value);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (value.trim().slice(0, MAX_QUERY) !== latest.current.filter.q) commit({ q: value });
      }, FILTER_DEBOUNCE_MS);
    },
    setOwner: (ownerPersonId: number | null) => commit({ ownerPersonId }),
    setHideClosed: (hideClosed: boolean) => commit({ hideClosed }),
    /** Every part off, at once (the empty state's button). */
    clear: () => {
      clearTimeout(timer.current);
      setTyped("");
      latest.current.setParams((previous) => withPlanFilter(previous, NO_FILTER), { replace: true });
      announce(t("plan.filter.cleared"));
      // The button that was pressed leaves with the empty state: the box is where the user goes on.
      searchRef.current?.focus();
    },
  };
}
