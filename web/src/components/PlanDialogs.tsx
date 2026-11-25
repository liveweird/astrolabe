import { useTranslation } from "react-i18next";
import { DELETE_TEXT, type PlanDialogsModel } from "../hooks/usePlanDialogs";
import { programMoveTargets, projectMoveTargets } from "../utils/planMove";
import { saveErrorMessage } from "../utils/saveError";
import ConfirmDeleteModal from "./ConfirmDeleteModal";
import JiraImportModal from "./JiraImportModal";
import PlanMoveModal from "./PlanMoveModal";
import ProgramEditorModal from "./ProgramEditorModal";
import ProjectEditorModal from "./ProjectEditorModal";
import WorkStreamEditorModal from "./WorkStreamEditorModal";

/** Everything the Plan page opens over the table: the three editors, the "Move to…" dialog, the Jira import and the delete confirmation. */
export default function PlanDialogs({ model }: { model: PlanDialogsModel }) {
  const { t } = useTranslation();
  const { data, editor, movingProject, movingProgram, jiraImport, remove } = model;
  const deleteText = remove.target ? DELETE_TEXT[remove.target.level] : DELETE_TEXT.workStream;
  return (
    <>
      {editor?.kind === "workStream" && <WorkStreamEditorModal target={editor.target} onClose={model.closeEditor} onSaved={model.saved} />}
      {editor?.kind === "program" && (
        <ProgramEditorModal workStream={editor.workStream} target={editor.target} onClose={model.closeEditor} onSaved={model.saved} />
      )}
      {editor?.kind === "project" && (
        <ProjectEditorModal program={editor.program} target={editor.target} onClose={model.closeEditor} onSaved={model.saved} />
      )}

      {data && movingProject && (
        <PlanMoveModal
          kind="project"
          node={movingProject.project}
          parentName={movingProject.program.name}
          data={projectMoveTargets(data, movingProject.project, t)}
          forbidden={!movingProject.project.can.move}
          onDone={model.moveDone}
          onRefresh={model.refresh}
          onClose={model.closeMove}
        />
      )}
      {data && movingProgram && (
        <PlanMoveModal
          kind="program"
          node={movingProgram.program}
          parentName={movingProgram.stream.name}
          data={programMoveTargets(data, movingProgram.program, t)}
          forbidden={!movingProgram.program.can.move}
          onDone={model.moveDone}
          onRefresh={model.refresh}
          onClose={model.closeMove}
        />
      )}

      {jiraImport.modal !== null && <JiraImportModal key={jiraImport.modalKey} {...jiraImport.modal} />}

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
    </>
  );
}
