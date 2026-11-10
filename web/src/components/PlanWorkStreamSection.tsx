import { useId } from "react";
import { Badge, Box, Button, Divider, Group, Menu, Paper, Stack, Text, Title } from "@mantine/core";
import { IconFileImport, IconLock, IconLockOpen, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { PlanWorkStream } from "../api/plan";
import type { PlanActions } from "../utils/planActions";
import DestructiveMenuItem from "./DestructiveMenuItem";
import PlanProgramBlock from "./PlanProgramBlock";
import RowActionsMenu from "./RowActionsMenu";

/**
 * One work stream of the plan: a bordered section titled by its name (h3) — a gray "Closed" badge when it has an end date (it
 * still takes programs) — with its owner and dates, the actions its `can` flags allow, and its programs underneath.
 */
export default function PlanWorkStreamSection({ workStream, actions }: { workStream: PlanWorkStream; actions: PlanActions }) {
  const { t } = useTranslation();
  const titleId = useId();
  const { can } = workStream;
  const closed = workStream.endDate !== null;
  return (
    <Paper component="section" withBorder p="md" aria-labelledby={titleId}>
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Box>
            <Group gap="xs">
              <Title order={3} size="h4" id={titleId}>
                {workStream.name}
              </Title>
              {closed && <Badge color="gray">{t("plan.closed")}</Badge>}
            </Group>
            <Text size="sm" c="dimmed">
              {t("plan.ownerLine", { name: workStream.ownerName })} ·{" "}
              {workStream.endDate === null
                ? t("plan.datesOpen", { start: workStream.startDate })
                : t("plan.window", { start: workStream.startDate, end: workStream.endDate })}
            </Text>
            {workStream.description && <Text size="sm">{workStream.description}</Text>}
          </Box>
          <Group gap="xs" wrap="nowrap">
            {can.createProgram && (
              <Button
                size="xs"
                variant="default"
                leftSection={<IconPlus size={14} />}
                aria-label={t("plan.newProgramAria", { name: workStream.name })}
                onClick={() => actions.newProgram(workStream)}
              >
                {t("plan.newProgram")}
              </Button>
            )}
            {(can.edit || can.delete) && (
              <RowActionsMenu label={t("common.table.operationsAria", { name: workStream.name })}>
                {can.edit && (
                  <Menu.Item
                    leftSection={<IconPencil size={14} />}
                    onClick={() => actions.editWorkStream(workStream)}
                    aria-label={t("common.action.editAria", { name: workStream.name })}
                  >
                    {t("common.action.edit")}
                  </Menu.Item>
                )}
                {can.edit && (
                  <Menu.Item
                    leftSection={closed ? <IconLockOpen size={14} /> : <IconLock size={14} />}
                    onClick={() => actions.setWorkStreamClosed(workStream, !closed)}
                    aria-label={t(closed ? "plan.workStream.reopenAria" : "plan.workStream.closeAria", { name: workStream.name })}
                  >
                    {t(closed ? "plan.workStream.reopen" : "plan.workStream.close")}
                  </Menu.Item>
                )}
                {can.edit && (
                  <Menu.Item
                    leftSection={<IconFileImport size={14} />}
                    onClick={() => actions.importFromJira(workStream)}
                    aria-label={t("jira.import.entryAria", { name: workStream.name })}
                  >
                    {t("jira.import.entry")}
                  </Menu.Item>
                )}
                {can.edit && can.delete && <Menu.Divider />}
                {can.delete && (
                  <DestructiveMenuItem
                    leftSection={<IconTrash size={14} />}
                    onClick={() => actions.deleteWorkStream(workStream)}
                    aria-label={t("common.action.deleteAria", { name: workStream.name })}
                  >
                    {t("common.action.delete")}
                  </DestructiveMenuItem>
                )}
              </RowActionsMenu>
            )}
          </Group>
        </Group>
        {workStream.programs.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t("plan.noPrograms")}
          </Text>
        ) : (
          workStream.programs.map((program) => (
            <Stack key={program.id} gap="md">
              <Divider />
              <PlanProgramBlock workStream={workStream} program={program} actions={actions} />
            </Stack>
          ))
        )}
      </Stack>
    </Paper>
  );
}
