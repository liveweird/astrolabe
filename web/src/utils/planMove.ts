import type { ComboboxItem, ComboboxItemGroup } from "@mantine/core";
import type { TFunction } from "i18next";
import type { PlanProgram, PlanProject, PlanView, PlanWorkStream } from "../api/plan";

/** A work stream's name as a move target: a closed stream still takes programs, and says so. */
const streamLabel = (stream: PlanWorkStream, t: TFunction) => (stream.endDate === null ? stream.name : t("plan.move.closedName", { name: stream.name }));

/**
 * The programs a project may move to: those whose `can.createProject` is set (the caller could create a project there — the target
 * half of the server's rule), minus the project's current program, grouped by work stream (closed streams labelled). Streams with no
 * eligible program drop out. Select values are the program ids as strings.
 */
export function projectMoveTargets(view: PlanView, project: Pick<PlanProject, "programId">, t: TFunction): ComboboxItemGroup<ComboboxItem>[] {
  return view.workStreams
    .map((stream) => ({
      group: streamLabel(stream, t),
      items: stream.programs
        .filter((program: PlanProgram) => program.can.createProject && program.id !== project.programId)
        .map((program) => ({ value: String(program.id), label: program.name })),
    }))
    .filter((group) => group.items.length > 0);
}

/** The work streams a program may move to: `can.createProgram` set, minus its current stream; closed ones labelled. */
export function programMoveTargets(view: PlanView, program: Pick<PlanProgram, "workStreamId">, t: TFunction): ComboboxItem[] {
  return view.workStreams
    .filter((stream) => stream.can.createProgram && stream.id !== program.workStreamId)
    .map((stream) => ({ value: String(stream.id), label: streamLabel(stream, t) }));
}

/** Whether a Select value is still among the (possibly regrouped) options — a refresh can take the picked target away. */
export function hasTarget(data: ComboboxItem[] | ComboboxItemGroup<ComboboxItem>[], value: string | null): boolean {
  if (value === null) return false;
  return data.some((entry) => ("items" in entry ? entry.items.some((item) => item.value === value) : entry.value === value));
}

/** The live project and the program that holds it NOW, found by id in the current view; null when it is gone. */
export function findProject(view: PlanView, id: number): { project: PlanProject; program: PlanProgram } | null {
  for (const stream of view.workStreams) {
    for (const program of stream.programs) {
      const project = program.projects.find((candidate) => candidate.id === id);
      if (project) return { project, program };
    }
  }
  return null;
}

/** The live program and the work stream that holds it NOW; null when it is gone. */
export function findProgram(view: PlanView, id: number): { program: PlanProgram; stream: PlanWorkStream } | null {
  for (const stream of view.workStreams) {
    const program = stream.programs.find((candidate) => candidate.id === id);
    if (program) return { program, stream };
  }
  return null;
}

/**
 * Whether "Move to…" is worth offering on a project: the server would allow the source half (`can.move`) AND at least one program
 * accepts it (`can.createProject`, not its own). A move the server would refuse for lack of a target is not offered at all.
 */
export function canMoveProject(view: PlanView, project: Pick<PlanProject, "programId" | "can">): boolean {
  return project.can.move && view.workStreams.some((stream) => stream.programs.some((program) => program.can.createProject && program.id !== project.programId));
}

/** The program counterpart: `can.move` and at least one other work stream with `can.createProgram`. */
export function canMoveProgram(view: PlanView, program: Pick<PlanProgram, "workStreamId" | "can">): boolean {
  return program.can.move && view.workStreams.some((stream) => stream.can.createProgram && stream.id !== program.workStreamId);
}
