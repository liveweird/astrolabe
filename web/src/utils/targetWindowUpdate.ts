import type { ProgramsProgram, ProgramsView } from "../api/programs";
import type { PlanFlag, RoadmapProject, RoadmapView } from "../api/roadmap";

// The optimistic step of a target-window write on the two cached plan views. The window is the one figure the SPA changes; the server's
// derived figures that depend on it - the drift and the drift flags - are not recomputed here: they are dropped (so a stale overrun band or
// a stale "ends 10 days after the target" never sits beside the new window) and the refetch after the write brings the server's own.
// The rank-inversion flags do not depend on the window and stay.

const isDriftFlag = (flag: PlanFlag) => flag.kind !== "RANK_INVERSION";

/** The project with its window replaced (a null pair clears it) and its drift and drift flags dropped. */
function withWindow(project: RoadmapProject, start: string | null, end: string | null): RoadmapProject {
  return { ...project, targetStart: start, targetEnd: end, drift: null, flags: project.flags.filter((flag) => !isDriftFlag(flag)) };
}

/** The roadmap view with one project's window replaced; the view as it is when the project is not in it. */
export function applyRoadmapWindow(view: RoadmapView, id: number, start: string | null, end: string | null): RoadmapView {
  const change = (project: RoadmapProject) => (project.id === id ? withWindow(project, start, end) : project);
  return { ...view, ranked: view.ranked.map((entry) => ({ ...entry, project: change(entry.project) })), unranked: view.unranked.map(change) };
}

type Counts = { warnings: number; infos: number };

/** A program with one project's window replaced and its roll-up lowered by the drift flags that project dropped (the counts are the server's sums over the projects' flags). */
function programWith(program: ProgramsProgram, target: RoadmapProject, start: string | null, end: string | null): { program: ProgramsProgram; lost: Counts } {
  const dropped = target.flags.filter(isDriftFlag);
  const warnings = dropped.filter((flag) => flag.severity === "WARNING").length;
  const lost = { warnings, infos: dropped.length - warnings };
  return {
    lost,
    program: {
      ...program,
      flags: { warnings: program.flags.warnings - lost.warnings, infos: program.flags.infos - lost.infos },
      projects: program.projects.map((project) => (project.id === target.id ? withWindow(project, start, end) : project)),
    },
  };
}

/** The programs view with one project's window replaced; its program's and work stream's roll-up counts follow (spans do not depend on a window). */
export function applyProgramsWindow(view: ProgramsView, id: number, start: string | null, end: string | null): ProgramsView {
  return {
    ...view,
    workStreams: view.workStreams.map((stream) => {
      const lost = { warnings: 0, infos: 0 };
      const programs = stream.programs.map((program) => {
        const target = program.projects.find((project) => project.id === id);
        if (target === undefined) return program;
        const changed = programWith(program, target, start, end);
        lost.warnings += changed.lost.warnings;
        lost.infos += changed.lost.infos;
        return changed.program;
      });
      return { ...stream, programs, flags: { warnings: stream.flags.warnings - lost.warnings, infos: stream.flags.infos - lost.infos } };
    }),
  };
}
