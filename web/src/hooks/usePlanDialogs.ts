import { useState, type RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ParseKeys } from "i18next";
import { useTranslation } from "react-i18next";
import { deleteProgram, deleteProject, deleteWorkStream, updateWorkStream, type PlanProgram, type PlanProject, type PlanView, type PlanWorkStream } from "../api/plan";
import { todayIsoDate } from "../utils/isoDate";
import type { PlanActions } from "../utils/planActions";
import { planSaveErrorMessage } from "../utils/planForm";
import { canMoveProgram, canMoveProject, findProgram, findProject } from "../utils/planMove";
import { programKey, streamKey } from "../utils/planTree";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { showSuccessToast } from "../utils/toast";
import { useDeleteConfirm, type DeleteConfirm } from "./useDeleteConfirm";
import { useDialogFocus } from "./useDialogFocus";
import { usePlanJiraImport } from "./usePlanJiraImport";

/** Which editor is open: a work stream (null = new), or a program / project under a parent (target null = new). */
export type EditorState =
  | { kind: "workStream"; target: PlanWorkStream | null }
  | { kind: "program"; workStream: PlanWorkStream; target: PlanProgram | null }
  | { kind: "project"; program: PlanProgram; target: PlanProject | null };

/**
 * Which "Move to…" dialog is open: only the node's kind and id. Everything the dialog shows (its name, its parent NOW, whether it may
 * still be moved) is read from the current view on every render, so a reload under the open dialog never leaves it on a stale snapshot.
 */
type MoveState = { kind: "project" | "program"; id: number };

export type DeleteTarget = { level: "workStream" | "program" | "project"; id: number; name: string };

export const DELETE_TEXT = {
  workStream: { title: "plan.workStream.deleteTitle", body: "plan.workStream.deleteBody", conflict: "plan.workStream.deleteConflict" },
  program: { title: "plan.program.deleteTitle", body: "plan.program.deleteBody", conflict: "plan.program.deleteConflict" },
  project: { title: "plan.project.deleteTitle", body: "plan.project.deleteBody", conflict: "plan.project.deleteConflict" },
} as const satisfies Record<DeleteTarget["level"], { title: ParseKeys; body: ParseKeys; conflict: ParseKeys }>;

function deleteRequest(target: DeleteTarget): Promise<void> {
  if (target.level === "workStream") return deleteWorkStream(target.id);
  return target.level === "program" ? deleteProgram(target.id) : deleteProject(target.id);
}

/** The end date of a one-step close: today, but never before the stream's start (ISO dates order as text). */
function closeDate(startDate: string): string {
  const today = todayIsoDate();
  return startDate > today ? startDate : today;
}

/** What `PlanDialogs` draws: everything open on the page that is not the table itself. */
export type PlanDialogsModel = {
  data: PlanView | undefined;
  editor: EditorState | null;
  closeEditor: () => void;
  saved: () => Promise<void>;
  movingProject: { project: PlanProject; program: PlanProgram } | null;
  movingProgram: { program: PlanProgram; stream: PlanWorkStream } | null;
  closeMove: () => void;
  moveDone: (target?: number) => Promise<void>;
  refresh: () => Promise<void>;
  jiraImport: ReturnType<typeof usePlanJiraImport>;
  remove: DeleteConfirm<DeleteTarget>;
};

/**
 * The Plan page's dialogs and what opens them: the three editors, the "Move to…" dialog, the Jira imports and the one delete confirmation, plus
 * the close / reopen mutation. `actions` is what a row may ask for (the table never owns a dialog); `onReveal` is told the keys of the folded nodes a
 * NEW, moved or imported program or project lands under, so the page can open them. Every success refreshes `["plan"]` and `["roadmap"]`.
 */
export function usePlanDialogs(data: PlanView | undefined, titleRef: RefObject<HTMLHeadingElement | null>, onReveal: (...keys: string[]) => void) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [moving, setMoving] = useState<MoveState | null>(null);
  // The Jira imports: a work stream's whole-scope one and the rooted ones of a linked program and of a linked project (hooks/usePlanJiraImport.ts).
  const jiraImport = usePlanJiraImport(data, onReveal);
  // Three hooks: an editor, a move dialog and an import are never open together, but each remembers its own opener.
  useDialogFocus(editor !== null);
  useDialogFocus(moving !== null);
  useDialogFocus(jiraImport.modal !== null);

  // A project created, renamed, re-owned, re-windowed or deleted changes the roadmap too.
  const refresh = () => refreshQueriesAfterMutation(queryClient, ["plan"], ["roadmap"]);

  const remove = useDeleteConfirm<DeleteTarget>({
    mutationFn: deleteRequest,
    onSuccess: refresh,
    successMessage: t("plan.toast.deleted"),
    focusAfterDelete: titleRef,
  });

  // Close / reopen is the one-step edit: the full-replace PUT of the stream as it stands, with only the end date changed.
  const closing = useMutation({
    mutationFn: ({ stream, closed }: { stream: PlanWorkStream; closed: boolean }) =>
      updateWorkStream(stream.id, {
        name: stream.name,
        description: stream.description,
        ownerPersonId: stream.ownerPersonId,
        startDate: stream.startDate,
        endDate: closed ? closeDate(stream.startDate) : null,
      }),
    onSuccess: async (_result, { closed }) => {
      showSuccessToast(t(closed ? "plan.workStream.toast.closed" : "plan.workStream.toast.reopened"));
      await refresh();
    },
  });

  const actions: PlanActions = {
    editWorkStream: (stream) => setEditor({ kind: "workStream", target: stream }),
    deleteWorkStream: (stream) => remove.requestDelete({ level: "workStream", id: stream.id, name: stream.name }),
    setWorkStreamClosed: (stream, closed) => closing.mutate({ stream, closed }),
    importFromJira: jiraImport.importFromJira,
    importChildren: jiraImport.importChildren,
    canImportChildren: jiraImport.canImportChildren,
    importMilestones: jiraImport.importMilestones,
    canImportMilestones: jiraImport.canImportMilestones,
    newProgram: (stream) => setEditor({ kind: "program", workStream: stream, target: null }),
    editProgram: (stream, program) => setEditor({ kind: "program", workStream: stream, target: program }),
    deleteProgram: (program) => remove.requestDelete({ level: "program", id: program.id, name: program.name }),
    newProject: (program) => setEditor({ kind: "project", program, target: null }),
    editProject: (program, project) => setEditor({ kind: "project", program, target: project }),
    deleteProject: (project) => remove.requestDelete({ level: "project", id: project.id, name: project.name }),
    moveProject: (project) => setMoving({ kind: "project", id: project.id }),
    moveProgram: (program) => setMoving({ kind: "program", id: program.id }),
    canMoveProject: (project) => data !== undefined && canMoveProject(data, project),
    canMoveProgram: (program) => data !== undefined && canMoveProgram(data, program),
  };

  // The open move dialog's node, read from the CURRENT view; when it is gone (deleted or reloaded away) the dialog closes, as on a 404.
  const movingProject = data && moving?.kind === "project" ? findProject(data, moving.id) : null;
  const movingProgram = data && moving?.kind === "program" ? findProgram(data, moving.id) : null;
  if (data && moving && !movingProject && !movingProgram) setMoving(null);

  const closeEditor = () => setEditor(null);
  const saved = async () => {
    // A node created under a folded parent would be saved out of sight: open the parent first.
    if (editor?.kind === "program" && editor.target === null) onReveal(streamKey(editor.workStream.id));
    if (editor?.kind === "project" && editor.target === null) onReveal(streamKey(editor.program.workStreamId), programKey(editor.program.id));
    closeEditor();
    await refresh();
  };

  // A move changes the roadmap's program / work stream columns too, and a mounted project view shows its program.
  const moveDone = async (target?: number) => {
    // The moved node must stay in sight: open where it went (a project: the program and its stream; a program: the stream).
    if (target !== undefined && moving?.kind === "project" && data) {
      const program = findProgram(data, target);
      if (program) onReveal(streamKey(program.stream.id), programKey(target));
    } else if (target !== undefined && moving?.kind === "program") onReveal(streamKey(target));
    setMoving(null);
    await refresh();
  };

  const model: PlanDialogsModel = { data, editor, closeEditor, saved, movingProject, movingProgram, closeMove: () => setMoving(null), moveDone, refresh, jiraImport, remove };
  return { actions, model, newWorkStream: () => setEditor({ kind: "workStream", target: null }), closeError: closing.isError ? planSaveErrorMessage(closing.error, t) : null };
}
