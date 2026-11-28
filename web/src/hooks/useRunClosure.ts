import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ProjectView } from "../api/milestones";
import { getRoadmapView, roadmapViewKey } from "../api/roadmap";
import { upstreamTeamIds } from "../utils/runClosure";
import { MAX_RUN_TEAMS } from "./useRunTeams";

/** The project waits on another project: one of its links has the predecessor in a different project and the successor in this one. */
const waitsOnOtherProject = (dependencies: ProjectView["dependencies"] | undefined, projectId: number): boolean =>
  (dependencies ?? []).some((link) => link.successor.projectId === projectId && link.predecessor.projectId !== projectId);

/**
 * "Add the teams this project waits on" (1.39): the project page's way to plan a dependency chain together. `add` (a click's, never automatic, so the Roadmap is not read at mount) reads the
 * Roadmap document through the query client (a cached copy is revalidated, not trusted), walks the WHOLE upstream chain of projects, nearest first (`upstreamTeamIds`), and adds every
 * team of it to the run's team set through `set` (the union with `ids`, the set at the time the answer arrives), up to the run's 50 teams. `note` says what happened (added N, nothing to
 * add, cut at the bound, read failed) and is announced too; `clear` drops it (a hand edit of the picker or Propose). `reading` is true while the document is on its way (one click at a time; the page keeps Propose off meanwhile, so no run starts over a set the answer is about to change). The same sentence twice is re-read by the page's `announce` itself.
 */
export function useRunClosure({
  projectId,
  dependencies,
  ids,
  set,
  announce,
}: {
  projectId: number;
  dependencies: ProjectView["dependencies"] | undefined;
  ids: readonly number[];
  set: (ids: readonly number[]) => void;
  announce: (text: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);
  // The picker may change while the document is read: the union is taken over the set as it is when the answer arrives, through the `set` of that render (it compares with the CURRENT default).
  const latest = useRef({ ids, set });
  useEffect(() => {
    latest.current = { ids, set };
  });
  const say = (text: string, failed = false) => {
    setNote({ text, failed });
    announce(text);
  };
  const add = async () => {
    if (reading) return;
    setReading(true);
    setNote(null);
    try {
      const document = await queryClient.fetchQuery({ queryKey: roadmapViewKey(null), queryFn: () => getRoadmapView(), retry: false });
      const projects = [...document.ranked.map((row) => row.project), ...document.unranked];
      const current = latest.current;
      const { ids: added, cut } = upstreamTeamIds(document.links, projects, [projectId], MAX_RUN_TEAMS, current.ids);
      if (added.length > 0) current.set([...current.ids, ...added]);
      if (cut) say(added.length > 0 ? t("project.proposal.closure.cut", { count: added.length, max: MAX_RUN_TEAMS }) : t("project.proposal.closure.cutNone", { max: MAX_RUN_TEAMS }));
      else say(added.length > 0 ? t("project.proposal.closure.added", { count: added.length }) : t("project.proposal.closure.none"));
    } catch {
      say(t("project.proposal.closure.failed"), true);
    } finally {
      setReading(false);
    }
  };
  return { available: waitsOnOtherProject(dependencies, projectId), reading, note, add, clear: () => setNote(null) };
}
