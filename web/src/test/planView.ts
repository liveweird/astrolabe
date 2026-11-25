// Fixtures for the plan view: whole documents as GET /views/plan answers them, typed over the schema.
import type { PlanProgram, PlanProject, PlanView, PlanWorkStream } from "../api/plan";

/** An empty plan the caller may add a work stream to. Override any member (`can` and `workStreams` are replaced whole). */
export function planView(over: Partial<PlanView> = {}): PlanView {
  return { revision: 1, workStreamOrderRevision: 0, can: { createWorkStream: true, orderWorkStreams: true }, workStreams: [], ...over };
}

type Named = { id: number; name: string };
/** A node's overrides take its `can` as a PARTIAL: every right is on unless the test turns it off. */
type WithCan<T extends { can: object }> = Omit<Partial<T>, "can"> & { can?: Partial<T["can"]> };

/** A project the caller may do everything to (`createDependency` included); override any member, `can` per flag. */
function planProject(over: Named & WithCan<PlanProject>): PlanProject {
  return {
    programId: 1,
    workStreamId: 1,
    description: null,
    ownerPersonId: 5,
    ownerName: "Piotr Project",
    targetStart: null,
    targetEnd: null,
    createdAt: 1,
    updatedAt: 2,
    ...over,
    can: { edit: true, delete: true, editTargetWindow: true, move: true, createMilestone: true, createDependency: true, ...over.can },
  };
}

function planProgram(over: Named & WithCan<PlanProgram>): PlanProgram {
  return {
    workStreamId: 1,
    description: null,
    ownerPersonId: 6,
    ownerName: "Pola Program",
    createdAt: 1,
    updatedAt: 2,
    projects: [],
    ...over,
    can: { edit: true, delete: true, createProject: true, move: true, ...over.can },
  };
}

function planWorkStream(over: Named & WithCan<PlanWorkStream>): PlanWorkStream {
  return {
    description: null,
    ownerPersonId: 4,
    ownerName: "Ola Owner",
    startDate: "2026-01-05",
    endDate: null,
    createdAt: 1,
    updatedAt: 2,
    programOrderRevision: 0,
    programs: [],
    ...over,
    can: { edit: true, delete: true, createProgram: true, orderPrograms: true, ...over.can },
  };
}

/** A project given to `planOf`: its parents' ids are filled in, so the document stays consistent. */
type ProjectSpec = Named & WithCan<PlanProject>;
type ProgramSpec = Named & Omit<WithCan<PlanProgram>, "projects"> & { projects?: readonly ProjectSpec[] };
type StreamSpec = Named & Omit<WithCan<PlanWorkStream>, "programs"> & { programs?: readonly ProgramSpec[] };

/**
 * The small plan a page test needs: work streams, programs and projects as plain `{ id, name, ... }` objects, every right on unless a node's
 * `can` says otherwise (a partial), the parents' ids filled in. Any member can be overridden node by node.
 */
export function planOf(streams: readonly StreamSpec[], over: Partial<PlanView> = {}): PlanView {
  return planView({
    ...over,
    workStreams: streams.map(({ programs = [], ...stream }) =>
      planWorkStream({
        ...stream,
        programs: programs.map(({ projects = [], ...program }) =>
          planProgram({
            ...program,
            workStreamId: stream.id,
            projects: projects.map((project) => planProject({ ...project, programId: program.id, workStreamId: stream.id })),
          }),
        ),
      }),
    ),
  });
}
