import { Badge, Button, Group, Menu, Stack, Table, Text, Title } from "@mantine/core";
import { IconLink, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { deleteDependency, type ProjectDependency } from "../api/dependencies";
import type { ProjectView } from "../api/milestones";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { dependencyEndpointText } from "../utils/dependencyForm";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import ConfirmDeleteModal from "./ConfirmDeleteModal";
import EmptyState from "./EmptyState";
import RowActionsMenu from "./RowActionsMenu";
import ScrollRegion from "./ScrollRegion";

const NO_WRAP = { whiteSpace: "nowrap" } as const;

/** The link's status: a red badge naming the shortfall, or a gray one - never colour alone. */
function StatusBadge({ dependency }: { dependency: ProjectDependency }) {
  const { t } = useTranslation();
  const { status, shortfallDays } = dependency.check;
  if (status === "VIOLATED") {
    return (
      // miw max-content: a badge shrinks (and clips its sentence with an ellipsis) when the table is tight; the column grows instead. tt none: the badge holds a sentence, not a label.
      <Badge color="red" variant="light" tt="none" miw="max-content">
        {t("project.dependency.status.violated", { count: shortfallDays ?? 0 })}
      </Badge>
    );
  }
  return (
    <Badge color="gray" variant="light" tt="none" miw="max-content">
      {t(status === "OK" ? "project.dependency.status.ok" : "project.dependency.status.unscheduled")}
    </Badge>
  );
}

/** The lag in working days; a negative one is a lead. */
const lagText = (lagDays: number, t: TFunction) =>
  lagDays < 0 ? `${t("project.dependency.lag", { count: lagDays })} ${t("project.dependency.lead")}` : t("project.dependency.lag", { count: lagDays });

function DependencyRow({
  dependency,
  ownProjectId,
  showCritical,
  onEdit,
  onDelete,
}: {
  dependency: ProjectDependency;
  ownProjectId: number;
  /** The critical-path toggle is on (v0.7): a critical link carries a gray "Critical path" badge. */
  showCritical: boolean;
  onEdit: (dependency: ProjectDependency) => void;
  onDelete: (dependency: ProjectDependency) => void;
}) {
  const { t } = useTranslation();
  const { predecessor, successor, check } = dependency;
  const name = `${dependencyEndpointText(predecessor, ownProjectId, t)} → ${dependencyEndpointText(successor, ownProjectId, t)}`;
  return (
    <Table.Tr>
      {/* Status, type and dates stay on one line (a badge clips its sentence, a date must not break at its hyphens); the ends wrap. */}
      <Table.Td style={NO_WRAP}>
        <StatusBadge dependency={dependency} />
        {showCritical && dependency.critical && (
          <Badge color="gray" variant="light" tt="none" miw="max-content" ml="xs">
            {t("project.critical.linkBadge")}
          </Badge>
        )}
      </Table.Td>
      <Table.Td>{dependencyEndpointText(predecessor, ownProjectId, t)}</Table.Td>
      <Table.Td>{t(`project.dependency.type.${dependency.type}`)}</Table.Td>
      <Table.Td>{lagText(dependency.lagDays, t)}</Table.Td>
      <Table.Td>{dependencyEndpointText(successor, ownProjectId, t)}</Table.Td>
      <Table.Td style={NO_WRAP}>
        {check.requiredDate !== null && check.actualDate !== null ? t("project.dependency.dates", { required: check.requiredDate, actual: check.actualDate }) : "–"}
      </Table.Td>
      <Table.Td style={{ width: 1 }} ta="right">
        {(dependency.can.edit || dependency.can.delete) && (
          <RowActionsMenu label={t("common.table.operationsAria", { name })}>
            {dependency.can.edit && (
              <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => onEdit(dependency)} aria-label={t("common.action.editAria", { name })}>
                {t("project.dependency.edit")}
              </Menu.Item>
            )}
            {dependency.can.delete && (
              <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => onDelete(dependency)} aria-label={t("common.action.deleteAria", { name })}>
                {t("common.action.delete")}
              </Menu.Item>
            )}
          </RowActionsMenu>
        )}
      </Table.Td>
    </Table.Tr>
  );
}

/**
 * The project's Dependencies section: the ACCESSIBLE surface of the links (the timeline's arrows are decoration). One row per link in
 * the server's order - violated first, largest shortfall first, so the top of the table is the conflict list - with what each
 * needs and what it has. Edit… (`can.edit`) asks the page to open the editor on that link (`onEdit`); Delete (the successor's chain,
 * `can.delete`) confirms through `useDeleteConfirm`; "Add dependency" asks the page to open the editor (`onAdd`), which also serves the
 * milestone row menu's shortcut. `showCritical` (the page's critical-path toggle,
 * v0.7) adds a gray "Critical path" badge to the links the server marked `critical`.
 */
export default function ProjectDependencies({
  view,
  onAdd,
  onEdit,
  showCritical = false,
}: {
  view: ProjectView;
  onAdd: () => void;
  onEdit: (dependency: ProjectDependency) => void;
  showCritical?: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const removal = useDeleteConfirm<ProjectDependency>({
    mutationFn: (dependency) => deleteDependency(dependency.id),
    onSuccess: () => refreshQueriesAfterMutation(queryClient, ["plan"]),
    successMessage: t("project.toast.dependencyDeleted"),
  });
  const { dependencies, project } = view;
  return (
    <Stack gap="xs">
      <Group gap="sm" align="center" justify="space-between">
        <Title order={3} size="h4">
          {t("project.dependenciesTitle")}
        </Title>
        {project.can.createDependency && (
          <Button variant="default" size="compact-md" leftSection={<IconPlus size={16} />} onClick={onAdd}>
            {t("project.dependency.add")}
          </Button>
        )}
      </Group>
      {dependencies.length === 0 ? (
        <EmptyState icon={IconLink} label={t("project.noDependencies")} hint={project.can.createDependency ? t("project.noDependenciesHint") : t("project.noDependenciesHintReadOnly")} />
      ) : (
        <>
          <Text size="sm" c="dimmed">
            {t("project.dependenciesIntro")}
          </Text>
          <ScrollRegion label={t("project.dependenciesAria")} minWidth={900}>
            <Table aria-label={t("project.dependenciesAria")}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("project.dependency.column.status")}</Table.Th>
                  <Table.Th>{t("project.dependency.column.predecessor")}</Table.Th>
                  <Table.Th>{t("project.dependency.column.type")}</Table.Th>
                  <Table.Th>{t("project.dependency.column.lag")}</Table.Th>
                  <Table.Th>{t("project.dependency.column.successor")}</Table.Th>
                  <Table.Th>{t("project.dependency.column.dates")}</Table.Th>
                  <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {dependencies.map((dependency) => (
                  <DependencyRow key={dependency.id} dependency={dependency} ownProjectId={project.id} showCritical={showCritical} onEdit={onEdit} onDelete={removal.requestDelete} />
                ))}
              </Table.Tbody>
            </Table>
          </ScrollRegion>
        </>
      )}
      <ConfirmDeleteModal
        confirm={removal}
        title={t("project.dependency.deleteTitle")}
        errorTitle={t("project.dependency.deleteFailed")}
        errorMessage={(error) =>
          saveErrorMessage(error, t, {
            forbidden: "project.dependency.saveForbidden",
            notFound: "project.saveGone",
            failedStatus: "common.error.actionFailedStatus",
            failed: "common.error.actionFailed",
          })
        }
        body={(dependency) =>
          t("project.dependency.deleteBody", {
            predecessor: dependencyEndpointText(dependency.predecessor, project.id, t),
            successor: dependencyEndpointText(dependency.successor, project.id, t),
            type: dependency.type,
          })
        }
      />
    </Stack>
  );
}
