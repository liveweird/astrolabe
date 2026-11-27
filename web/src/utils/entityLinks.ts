import { personPath } from "./peopleLinks";
import { milestonePath, programPath, projectPath, workStreamPath } from "./planLinks";
import { teamPath } from "./teamLinks";
import { editUserPath } from "./userLinks";

/**
 * What a name stands for (1.31): the six entities the app names, and the one place each is addressed. A milestone has no page of its own, so it carries
 * its project; a `user` is a login (its address is the ADMIN edit page), a `person` is an owner or manager of the plan.
 */
export type EntityRef =
  | { kind: "workStream" | "program" | "project" | "team" | "person" | "user"; id: number }
  | { kind: "milestone"; id: number; projectId: number };

/** The address of an entity, spelled by the area's own path helper (never hand-assembled): the destination of `EntityLink`. */
export function entityPath(ref: EntityRef): string {
  switch (ref.kind) {
    case "workStream":
      return workStreamPath(ref.id);
    case "program":
      return programPath(ref.id);
    case "project":
      return projectPath(ref.id);
    case "milestone":
      return milestonePath(ref.projectId, ref.id);
    case "team":
      return teamPath(ref.id);
    case "person":
      return personPath(ref.id);
    case "user":
      return editUserPath(ref.id);
  }
}

/** A ref to an entity whose id may be unknown (a person a login has none of, a node a document does not name): `null` then, which `EntityLink` shows as plain text. */
export const refOf = (kind: Exclude<EntityRef["kind"], "milestone">, id: number | null | undefined): EntityRef | null => (id == null ? null : { kind, id });
