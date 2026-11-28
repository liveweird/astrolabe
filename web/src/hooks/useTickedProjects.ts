import { useState } from "react";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import { NO_PROJECTS, overlayProjects } from "../utils/planProposal";
import type { ScheduleCheckState } from "../utils/scheduleProposal";

type Projects = CrossTeamProposal["projects"];

/** What the page draws of the projects, and whether it describes a ticked subset (the check's answer) rather than every move of the run. */
export type TickedProjects = { projects: Projects; ticked: boolean };

/**
 * The projects that follow the TICKS (`overlayProjects`), with one more rule (1.38): while a newer check is on its way (or has failed) the LAST value shown stays, so nothing
 * flashes back to the whole run between two ticks. The memory is per run: a run that replaces the last one shows its own projects until its first answer.
 * `follows` is whether the viewer's ticks decide at all (`overlayProjects`' `canAccept`).
 */
export function useTickedProjects(run: Pick<CrossTeamProposal, "projects"> | null, check: Pick<ScheduleCheckState, "mode" | "projects">, follows: boolean): TickedProjects {
  const [last, setLast] = useState<{ run: object | null; value: TickedProjects } | null>(null);
  const pending = follows && check.mode === "some" && check.projects === null;
  const settled: TickedProjects | null = pending ? null : { projects: overlayProjects(run, check, follows), ticked: follows && check.mode !== "all" };
  if (settled !== null && (last === null || last.run !== run || last.value.projects !== settled.projects || last.value.ticked !== settled.ticked)) setLast({ run, value: settled });
  if (settled !== null) return settled;
  return last !== null && last.run === run ? last.value : { projects: run?.projects ?? NO_PROJECTS, ticked: false };
}
