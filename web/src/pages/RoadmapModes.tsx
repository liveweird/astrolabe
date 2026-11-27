import { useEffect, useRef } from "react";
import { SegmentedControl } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { isOneOf, readStoredJson, writeStoredJson } from "../hooks/useStoredState";
import { ROADMAP_MODES, type RoadmapMode } from "../utils/planLinks";
import { hasPrioritizationOnlyParams, withRoadmapFilterParams } from "../utils/roadmapFilterParams";
import { PROPOSAL_PARAM, withoutProposal } from "../utils/savedProposal";
import classes from "../theme.module.css";
import Programs from "./Programs";
import Roadmap from "./Roadmap";

/** The remembered mode (`astrolabe.viewSettings.roadmap.mode`): what the user last chose with the switch in this browser. */
const MODE_KEY = "roadmap.mode";
const isMode = isOneOf<RoadmapMode>(ROADMAP_MODES);

/** The mode the browser remembers; Prioritization on a first visit, or when the stored value is not one of the two words. */
function rememberedMode(): RoadmapMode {
  const stored = readStoredJson(MODE_KEY);
  return isMode(stored) ? stored : "prioritization";
}

/** The search with `mode` set and written first; every other parameter is kept as it was. */
function withMode(current: URLSearchParams, mode: RoadmapMode): URLSearchParams {
  const next = new URLSearchParams([["mode", mode]]);
  for (const [name, value] of current) if (name !== "mode") next.append(name, value);
  return next;
}

/** A switch leaves the filters, the pick and the open saved proposal (the overview's, 1.33) behind: each mode restores its own filters from the browser's memory (the pick is one shared memory). The dependency panel's parameters and foreign ones stay. */
const withoutFilters = (current: URLSearchParams) => withoutProposal(withRoadmapFilterParams(current, {}));

/**
 * The Roadmap (`/roadmap`, 1.29): ONE page in two modes, `?mode=prioritization` (the projects by global rank: `pages/Roadmap.tsx`) and
 * `?mode=overview` (the tree of projects under programs and work streams: `pages/Programs.tsx`). The two bodies are today's pages, each with its own
 * filters, memory and operations; this page owns only the mode.
 *
 *  - An address naming a valid `mode` is shown as written and changes nothing the browser remembers.
 *  - An address without one (the nav link, Home's card, an old bookmark) renders ONLY a `replace` redirect to the same address (hash and state kept) plus the
 *    remembered mode (`roadmap.mode`, Prioritization on a first visit) - or Prioritization whatever is remembered when the address names a filter only that mode has, or the overview when it names a saved proposal (`proposal`, which only the overview reads). The body mounts on the next render: `useRoadmapFilters` and `useProgramPick` each rewrite the
 *    address on mount, and a second writer in the first commit would clobber the first.
 *  - The switch (a labelled radiogroup, in the header's toolbar row, rendered by whichever body is shown) writes the memory and puts the new `mode` in
 *    the address as a history entry, so Back returns to the other mode. The filters and the pick leave the address (each mode restores its own from the
 *    browser's memory; a pick that came only from a link is not carried across); the dependency panel's parameters and foreign ones stay.
 *  - The pathname does not change, so `useFocusMainOnNavigation` leaves the focus alone; the body remounts the control, so the page puts the focus back
 *    on the chosen option itself, and after Back/forward between modes on the main region (it would otherwise be lost on `body`).
 */
export default function RoadmapModes() {
  const { t } = useTranslation();
  const { pathname, hash, state } = useLocation();
  const [params, setParams] = useSearchParams();
  const named = params.get("mode");
  const mode = isMode(named) ? named : null;
  const control = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const shown = useRef<RoadmapMode | null>(null);
  useEffect(() => {
    const before = shown.current;
    shown.current = mode;
    if (refocus.current) {
      refocus.current = false;
      control.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
    } else if (before !== null && mode !== null && before !== mode) {
      // Back / forward between the modes: the control that had the focus was replaced.
      document.getElementById("main-content")?.focus({ preventScroll: true });
    }
  }, [mode]);

  if (mode === null) {
    // `proposal` (a saved proposal's address, 1.33) belongs to the overview alone, as `programId` does not belong to Prioritization alone.
    const first: RoadmapMode = params.has(PROPOSAL_PARAM) ? "overview" : hasPrioritizationOnlyParams(params) ? "prioritization" : rememberedMode();
    return <Navigate replace to={{ pathname, search: withMode(params, first).toString(), hash }} state={state} />;
  }

  function choose(next: string) {
    if (!isMode(next) || next === mode) return;
    writeStoredJson(MODE_KEY, next);
    refocus.current = true;
    setParams(withMode(withoutFilters(params), next));
  }

  const modeSwitch = (
    <SegmentedControl
      ref={control}
      size="xs"
      w="fit-content"
      data-print="hide"
      // The same plain switch as the zoom control (no 200 ms easing, so a theme switch recolours it with the rest of the toolbar); the checked option
      // carries an outline of its own too, so forced colours (which drop the indicator's background) still show it.
      transitionDuration={0}
      classNames={{ indicator: classes.modeIndicator }}
      aria-label={t("roadmap.mode.aria")}
      value={mode}
      onChange={choose}
      data={ROADMAP_MODES.map((value) => ({ value, label: t(`roadmap.mode.${value}`) }))}
    />
  );
  return mode === "prioritization" ? <Roadmap modeSwitch={modeSwitch} /> : <Programs modeSwitch={modeSwitch} />;
}
