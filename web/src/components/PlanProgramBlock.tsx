import { Anchor, Box, Button, Group, Menu, Stack, Table, Text, Title } from "@mantine/core";
import { IconArrowsExchange, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import type { PlanProgram, PlanWorkStream } from "../api/plan";
import type { PlanActions } from "../utils/planActions";
import { projectPath } from "../utils/planLinks";
import DestructiveMenuItem from "./DestructiveMenuItem";
import RowActionsMenu from "./RowActionsMenu";
import ScrollRegion from "./ScrollRegion";

/**
 * One program of a work stream: its heading (h4), owner line and the actions its `can` flags allow, then its projects in a
 * table (name, owner, target window — the project rows' own `can` flags decide their menu). Nothing here decides rights.
 */
export default function PlanProgramBlock({
  workStream,
  program,
  actions,
}: {
  workStream: PlanWorkStream;
  program: PlanProgram;
  actions: PlanActions;
}) {
  const { t } = useTranslation();
  const { can } = program;
  const canMoveProgram = actions.canMoveProgram(program);
  const tableLabel = t("plan.projectsTableAria", { name: program.name });
  return (
    <Stack gap="xs">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Box>
          <Title order={4} size="h5">
            {program.name}
          </Title>
          <Text size="sm" c="dimmed">
            {t("plan.ownerLine", { name: program.ownerName })}
          </Text>
          {program.description && <Text size="sm">{program.description}</Text>}
        </Box>
        <Group gap="xs" wrap="nowrap">
          {can.createProject && (
            <Button
              size="xs"
              variant="default"
              leftSection={<IconPlus size={14} />}
              aria-label={t("plan.newProjectAria", { name: program.name })}
              onClick={() => actions.newProject(program)}
            >
              {t("plan.newProject")}
            </Button>
          )}
          {(can.edit || canMoveProgram || can.delete) && (
            <RowActionsMenu label={t("common.table.operationsAria", { name: program.name })}>
              {can.edit && (
                <Menu.Item
                  leftSection={<IconPencil size={14} />}
                  onClick={() => actions.editProgram(workStream, program)}
                  aria-label={t("common.action.editAria", { name: program.name })}
                >
                  {t("common.action.edit")}
                </Menu.Item>
              )}
              {canMoveProgram && (
                <Menu.Item
                  leftSection={<IconArrowsExchange size={14} />}
                  onClick={() => actions.moveProgram(program)}
                  aria-label={t("plan.move.programAria", { name: program.name })}
                >
                  {t("plan.move.action")}
                </Menu.Item>
              )}
              {(can.edit || canMoveProgram) && can.delete && <Menu.Divider />}
              {can.delete && (
                <DestructiveMenuItem
                  leftSection={<IconTrash size={14} />}
                  onClick={() => actions.deleteProgram(program)}
                  aria-label={t("common.action.deleteAria", { name: program.name })}
                >
                  {t("common.action.delete")}
                </DestructiveMenuItem>
              )}
            </RowActionsMenu>
          )}
        </Group>
      </Group>
      {program.projects.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t("plan.noProjects")}
        </Text>
      ) : (
        <ScrollRegion label={tableLabel} minWidth={560}>
          <Table aria-label={tableLabel}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("plan.column.project")}</Table.Th>
                <Table.Th>{t("common.field.owner")}</Table.Th>
                <Table.Th>{t("common.field.targetWindow")}</Table.Th>
                <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {program.projects.map((project) => (
                <Table.Tr key={project.id}>
                  <Table.Td>
                    <Anchor component={RouterLink} to={projectPath(project.id)} size="sm" fw={500} aria-label={t("plan.openProjectAria", { name: project.name })}>
                      {project.name}
                    </Anchor>
                    {project.description && (
                      <Text size="xs" c="dimmed">
                        {project.description}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{project.ownerName}</Text>
                  </Table.Td>
                  <Table.Td>
                    {project.targetStart !== null && project.targetEnd !== null ? (
                      <Text size="sm">{t("plan.window", { start: project.targetStart, end: project.targetEnd })}</Text>
                    ) : (
                      <Text size="sm" c="dimmed">
                        {t("plan.noWindow")}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td style={{ width: 1 }} ta="right">
                    {(project.can.edit || project.can.editTargetWindow || actions.canMoveProject(project) || project.can.delete) && (
                      <RowActionsMenu label={t("common.table.operationsAria", { name: project.name })}>
                        {(project.can.edit || project.can.editTargetWindow) && (
                          <Menu.Item
                            leftSection={<IconPencil size={14} />}
                            onClick={() => actions.editProject(program, project)}
                            aria-label={t("common.action.editAria", { name: project.name })}
                          >
                            {t("common.action.edit")}
                          </Menu.Item>
                        )}
                        {actions.canMoveProject(project) && (
                          <Menu.Item
                            leftSection={<IconArrowsExchange size={14} />}
                            onClick={() => actions.moveProject(project)}
                            aria-label={t("plan.move.projectAria", { name: project.name })}
                          >
                            {t("plan.move.action")}
                          </Menu.Item>
                        )}
                        {(project.can.edit || project.can.editTargetWindow || actions.canMoveProject(project)) && project.can.delete && <Menu.Divider />}
                        {project.can.delete && (
                          <DestructiveMenuItem
                            leftSection={<IconTrash size={14} />}
                            onClick={() => actions.deleteProject(project)}
                            aria-label={t("common.action.deleteAria", { name: project.name })}
                          >
                            {t("common.action.delete")}
                          </DestructiveMenuItem>
                        )}
                      </RowActionsMenu>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollRegion>
      )}
    </Stack>
  );
}
