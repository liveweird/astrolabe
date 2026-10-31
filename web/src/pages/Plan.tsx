import { useState } from "react";
import { Button, Stack } from "@mantine/core";
import { IconPlus, IconSitemap } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ParseKeys } from "i18next";
import { useTranslation } from "react-i18next";
import {
  deleteProgram,
  deleteProject,
  deleteWorkStream,
  getPlanView,
  updateWorkStream,
  type PlanProgram,
  type PlanProject,
  type PlanWorkStream,
} from "../api/plan";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import FormErrorAlert from "../components/FormErrorAlert";
import LoadingBlock from "../components/LoadingBlock";
import PageHeader from "../components/PageHeader";
import PlanWorkStreamSection from "../components/PlanWorkStreamSection";
import ProgramEditorModal from "../components/ProgramEditorModal";
import ProjectEditorModal from "../components/ProjectEditorModal";
import WorkStreamEditorModal from "../components/WorkStreamEditorModal";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { todayIsoDate } from "../utils/isoDate";
import type { PlanActions } from "../utils/planActions";
import { planSaveErrorMessage } from "../utils/planForm";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";

/** Which editor is open: a work stream (null = new), or a program / project under a parent (target null = new). */
type EditorState =
  | { kind: "workStream"; target: PlanWorkStream | null }
  | { kind: "program"; workStream: PlanWorkStream; target: PlanProgram | null }
  | { kind: "project"; program: PlanProgram; target: PlanProject | null };

type DeleteTarget = { level: "workStream" | "program" | "project"; id: number; name: string };

const DELETE_TEXT = {
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

/**
 * The Plan page (`/plan`): the whole hierarchy work stream → program → project, readable by everyone. What each row offers
 * comes from the server's `can:{}` flags in the view (the same arithmetic as the guards), never from the session's roles.
 */
export default function Plan() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({ queryKey: ["plan", "view"], queryFn: getPlanView });
  const [editor, setEditor] = useState<EditorState | null>(null);

  // A project created, renamed, re-owned, re-windowed or deleted changes the roadmap too.
  const refresh = () => refreshQueriesAfterMutation(queryClient, ["plan"], ["roadmap"]);

  const remove = useDeleteConfirm<DeleteTarget>({
    mutationFn: deleteRequest,
    onSuccess: refresh,
    successMessage: t("plan.toast.deleted"),
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
    newProgram: (stream) => setEditor({ kind: "program", workStream: stream, target: null }),
    editProgram: (stream, program) => setEditor({ kind: "program", workStream: stream, target: program }),
    deleteProgram: (program) => remove.requestDelete({ level: "program", id: program.id, name: program.name }),
    newProject: (program) => setEditor({ kind: "project", program, target: null }),
    editProject: (program, project) => setEditor({ kind: "project", program, target: project }),
    deleteProject: (project) => remove.requestDelete({ level: "project", id: project.id, name: project.name }),
  };

  const closeEditor = () => setEditor(null);
  const saved = async () => {
    closeEditor();
    await refresh();
  };

  const canCreate = data?.can.createWorkStream ?? false;
  const deleteText = remove.target ? DELETE_TEXT[remove.target.level] : DELETE_TEXT.workStream;

  return (
    <Stack gap="md">
      <PageHeader
        title={t("plan.title")}
        description={t("plan.intro")}
        actions={
          canCreate && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setEditor({ kind: "workStream", target: null })}>
              {t("plan.newWorkStream")}
            </Button>
          )
        }
      />

      {isError && <ErrorAlert error={error} title={t("plan.loadFailed")} />}
      {closing.isError && <FormErrorAlert>{planSaveErrorMessage(closing.error, t)}</FormErrorAlert>}

      {isLoading && <LoadingBlock />}
      {data && data.workStreams.length === 0 && (
        <EmptyState icon={IconSitemap} label={t("plan.empty")} hint={canCreate ? t("plan.emptyHintCreate") : t("plan.emptyHint")} />
      )}
      {data?.workStreams.map((stream) => <PlanWorkStreamSection key={stream.id} workStream={stream} actions={actions} />)}

      {editor?.kind === "workStream" && <WorkStreamEditorModal target={editor.target} onClose={closeEditor} onSaved={saved} />}
      {editor?.kind === "program" && (
        <ProgramEditorModal workStream={editor.workStream} target={editor.target} onClose={closeEditor} onSaved={saved} />
      )}
      {editor?.kind === "project" && (
        <ProjectEditorModal program={editor.program} target={editor.target} onClose={closeEditor} onSaved={saved} />
      )}

      <ConfirmDeleteModal
        confirm={remove}
        title={t(deleteText.title)}
        errorTitle={t("plan.deleteFailed")}
        errorMessage={(err) =>
          saveErrorMessage(err, t, {
            forbidden: "plan.saveForbidden",
            notFound: "plan.saveGone",
            conflict: deleteText.conflict,
            failedStatus: "common.error.actionFailedStatus",
            failed: "common.error.actionFailed",
          })
        }
        body={(target) => t(DELETE_TEXT[target.level].body, { name: target.name })}
      />
    </Stack>
  );
}
