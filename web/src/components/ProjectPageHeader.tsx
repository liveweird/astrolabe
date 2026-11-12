import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { Button, Text } from "@mantine/core";
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import type { ProjectView as ProjectViewDocument } from "../api/milestones";
import { planPath } from "../utils/planLinks";
import type { JiraMark, JiraMarks } from "../utils/jiraMarks";
import { ProjectJiraButton, ProjectJiraImportButton } from "./JiraChips";
import PageHeader from "./PageHeader";

type ProjectHeaderProps = {
  project: ProjectViewDocument["project"];
  marks: JiraMarks;
  titleRef: Ref<HTMLHeadingElement>;
  onNewMilestone: () => void;
  onEdit: () => void;
  onLinkJira: () => void;
  onImportJira: () => void;
  onUnlinkJira: (mark: JiraMark) => void;
  onDelete: () => void;
};

/**
 * The project page's header: the name, the description and meta lines, and the actions the project's own `can:{…}` offers (New
 * milestone, Edit, the Jira link/unlink, Import from Jira, Delete).
 */
export default function ProjectPageHeader({ project, marks, titleRef, onNewMilestone, onEdit, onLinkJira, onImportJira, onUnlinkJira, onDelete }: ProjectHeaderProps) {
  const { t } = useTranslation();
  return (
    <PageHeader
      titleRef={titleRef}
      title={project.name}
      description={
        <>
          {project.description && (
            <Text span display="block">
              {project.description}
            </Text>
          )}
          <Text span display="block">
            {t("project.metaLine", { program: project.programName, workStream: project.workStreamName, owner: project.ownerName })}
          </Text>
        </>
      }
      backTo={{ to: planPath, label: t("project.backToPlan") }}
      actions={
        <>
          {project.can.createMilestone && (
            <Button leftSection={<IconPlus size={16} />} onClick={onNewMilestone}>
              {t("project.newMilestone")}
            </Button>
          )}
          {(project.can.edit || project.can.editTargetWindow) && (
            <Button variant="default" leftSection={<IconPencil size={16} />} onClick={onEdit}>
              {t("common.action.edit")}
            </Button>
          )}
          <ProjectJiraButton project={project} marks={marks} onLink={onLinkJira} onUnlink={onUnlinkJira} />
          <ProjectJiraImportButton project={project} marks={marks} onImport={onImportJira} />
          {project.can.delete && (
            <Button color="red" variant="light" leftSection={<IconTrash size={16} />} onClick={onDelete}>
              {t("common.action.delete")}
            </Button>
          )}
        </>
      }
    />
  );
}
