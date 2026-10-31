import type { PlanProgram, PlanProject, PlanWorkStream } from "../api/plan";

/** What a plan row can ask the page to do — the page owns the editors, the delete confirmation and the mutations. */
export type PlanActions = {
  editWorkStream: (stream: PlanWorkStream) => void;
  deleteWorkStream: (stream: PlanWorkStream) => void;
  /** Close (end date today, never before the start) or reopen (no end date) a stream in one step. */
  setWorkStreamClosed: (stream: PlanWorkStream, closed: boolean) => void;
  newProgram: (stream: PlanWorkStream) => void;
  editProgram: (stream: PlanWorkStream, program: PlanProgram) => void;
  deleteProgram: (program: PlanProgram) => void;
  newProject: (program: PlanProgram) => void;
  editProject: (program: PlanProgram, project: PlanProject) => void;
  deleteProject: (project: PlanProject) => void;
  /** Open the "Move to…" dialog: a project under another program, a program under another work stream. */
  moveProject: (project: PlanProject) => void;
  moveProgram: (program: PlanProgram) => void;
  /** Whether the row offers "Move to…": its own `can.move` AND at least one eligible target (never an action the server would refuse). */
  canMoveProject: (project: PlanProject) => boolean;
  canMoveProgram: (program: PlanProgram) => boolean;
};
