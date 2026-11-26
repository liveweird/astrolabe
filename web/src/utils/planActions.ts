import type { MouseEvent } from "react";
import type { PlanProgram, PlanProject, PlanWorkStream } from "../api/plan";
import type { NodeRow, PlanTreeRow } from "./planTree";

/** What a plan row can ask the page to do — the page owns the editors, the delete confirmation and the mutations. */
export type PlanActions = {
  editWorkStream: (stream: PlanWorkStream) => void;
  deleteWorkStream: (stream: PlanWorkStream) => void;
  /** Close (end date today, never before the start) or reopen (no end date) a stream in one step. */
  setWorkStreamClosed: (stream: PlanWorkStream, closed: boolean) => void;
  /** Open the Jira import for this stream (a stream's owner or ADMIN; the stream is preset in the dialog). */
  importFromJira: (stream: PlanWorkStream) => void;
  /** Open the Jira import rooted at this LINKED program (1.14: only what Jira lists under its item; the program's owner chain or ADMIN). */
  importChildren: (program: PlanProgram) => void;
  /** Whether the program offers it: its own `can.createProject` AND a Jira link (the Plan page reads the links once). */
  canImportChildren: (program: PlanProgram) => boolean;
  /** Open the Jira import rooted at this LINKED project (1.15: only what Jira lists under its item; the project's owner chain or ADMIN). */
  importMilestones: (project: PlanProject) => void;
  /** Whether the project row offers it: its own `can.createMilestone` AND a Jira link. */
  canImportMilestones: (project: PlanProject) => boolean;
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

/** What a row's view group may ask of the page (the focus and the pins), apart from the dialogs' `PlanActions`. */
export type PlanViewActions = {
  /** Whether the node is a pinned root (the pin marker, the menu's Pin or Unpin). */
  isPinned: (key: string) => boolean;
  pin: (row: PlanTreeRow) => void;
  /** Unpin from the row menu (the focus stays on the menu button). */
  unpin: (key: string, name: string) => void;
  /** Unpin with the pinned section's own button, which leaves the page: the page moves the focus on. */
  releasePin: (key: string, name: string) => void;
  /** Where "Show only this" goes for a work stream or program row: the address with the focus set and the filters kept. */
  focusHref: (row: NodeRow) => string;
  /** "Show only this" was chosen (an ordinary click, not one that opens the link elsewhere): the page says so. */
  focused: (row: NodeRow, event: MouseEvent) => void;
};
