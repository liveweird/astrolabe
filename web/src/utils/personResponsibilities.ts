import type { PlanView } from "../api/plan";

/** A work stream as the lists name it: `closed` once its end is set (it reads "(closed)", as everywhere else). */
export type StreamRef = { id: number; name: string; closed: boolean };

export type Owned = {
  workStreams: StreamRef[];
  programs: { id: number; name: string; workStream: StreamRef }[];
  projects: { id: number; name: string; program: { id: number; name: string }; workStream: StreamRef }[];
};

/**
 * What a person OWNS, read off the plan view: the work streams, programs and projects whose `ownerPersonId` is theirs, each with the parents the list names, in
 * the plan's own order (the shared work stream order, a stream's program order, projects by name). Only active nodes exist in the view, so nothing deleted is
 * listed. A node under a stream, program or project the person does not own still lists on its own account (ownership is direct, never inherited).
 */
export function ownedBy(plan: PlanView, personId: number): Owned {
  const owned: Owned = { workStreams: [], programs: [], projects: [] };
  for (const stream of plan.workStreams) {
    const streamRef: StreamRef = { id: stream.id, name: stream.name, closed: stream.endDate !== null };
    if (stream.ownerPersonId === personId) owned.workStreams.push(streamRef);
    for (const program of stream.programs) {
      if (program.ownerPersonId === personId) owned.programs.push({ id: program.id, name: program.name, workStream: streamRef });
      for (const project of program.projects) {
        if (project.ownerPersonId === personId) {
          owned.projects.push({ id: project.id, name: project.name, program: { id: program.id, name: program.name }, workStream: streamRef });
        }
      }
    }
  }
  return owned;
}
