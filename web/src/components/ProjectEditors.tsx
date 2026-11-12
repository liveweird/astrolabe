import type { ProjectView as ProjectViewDocument } from "../api/milestones";
import type { useJiraLinks } from "../hooks/useDeviations";
import { importSourceOf, type ImportRoot } from "../utils/jiraImport";
import { isJiraEditor, type Editor } from "../utils/projectEditor";
import DependencyEditorModal from "./DependencyEditorModal";
import JiraBindDialog from "./JiraBindDialog";
import JiraImportModal from "./JiraImportModal";
import MilestoneEditorModal from "./MilestoneEditorModal";
import ProjectEditorModal from "./ProjectEditorModal";

type ProjectEditorsProps = {
  editor: Editor | null;
  view: ProjectViewDocument;
  links: ReturnType<typeof useJiraLinks>;
  onClose: () => void;
  /** A plan write was saved: the page closes the dialog and refreshes the plan and the roadmap. */
  onSaved: () => Promise<void>;
  /** A Jira link was made: the page closes the dialog and re-reads the Jira queries and the timeline views. */
  onBound: () => Promise<void>;
};

/** The rooted import's root (1.14): the project and its link; the owner is the project's own (the modal sends it, it asks for none). Null while the view holds no link. */
function importRoot(project: ProjectViewDocument["project"]): ImportRoot | null {
  if (project.jira === null) return null;
  return {
    level: "PROJECT",
    nodeId: project.id,
    name: project.name,
    issueKey: project.jira.issueKey,
    connectionId: project.jira.connectionId,
    workStreamId: project.workStreamId,
    owner: { value: String(project.ownerPersonId), label: project.ownerName },
  };
}

/** The dialogs the project page mounts for its open `editor` (at most one): milestone, project, dependency, Jira bind or the import rooted at the project. */
export default function ProjectEditors({ editor, view, links, onClose, onSaved, onBound }: ProjectEditorsProps) {
  const { project } = view;
  const root = editor?.kind === "jiraImport" ? importRoot(project) : null;
  return (
    <>
      {editor?.kind === "create" && <MilestoneEditorModal project={project} target={null} onClose={onClose} onSaved={onSaved} />}
      {editor?.kind === "edit" && <MilestoneEditorModal project={project} target={editor.milestone} onClose={onClose} onSaved={onSaved} />}
      {editor?.kind === "project" && (
        <ProjectEditorModal program={{ id: project.programId, name: project.programName }} target={project} onClose={onClose} onSaved={onSaved} />
      )}
      {(editor?.kind === "dependency" || editor?.kind === "editDependency") && (
        <DependencyEditorModal
          project={project}
          milestones={[...view.scheduled, ...view.unscheduled]}
          successor={editor.kind === "dependency" ? editor.successor : null}
          target={editor.kind === "editDependency" ? editor.dependency : null}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
      {isJiraEditor(editor) && <JiraBindDialog source={links} target={editor.target} onClose={onClose} onBound={onBound} />}
      {root !== null && <JiraImportModal source={importSourceOf(links)} root={root} onClose={onClose} />}
    </>
  );
}
