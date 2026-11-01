import { useState } from "react";
import { Button, Group, Menu, Stack, Table, Text, Title } from "@mantine/core";
import { IconGauge, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { deleteCapacityPeriod, type CapacityPeriod, type TeamView } from "../api/teams";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import CapacityPeriodModal from "./CapacityPeriodModal";
import ConfirmDeleteModal from "./ConfirmDeleteModal";
import EmptyState from "./EmptyState";
import RowActionsMenu from "./RowActionsMenu";
import ScrollRegion from "./ScrollRegion";

type Editor = { kind: "create" } | { kind: "edit"; period: CapacityPeriod };

/**
 * The team's Capacity section: its periods (the date each takes effect, man-days per week, the optional WIP limit — "—" when none),
 * oldest first as the server lists them. This table is where the limits are READ (the weekly load carries only the verdicts). Adding,
 * editing and deleting are the view's `can.editCapacity` (the team's manager or an ADMIN) — the server's guard is the rule. Capacity is
 * team data, not plan state: a write refreshes the view (`["plan"]`) and bumps no revision.
 */
export default function TeamCapacity({ view }: { view: TeamView }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<Editor | null>(null);
  const { periods } = view.capacity;
  const canEdit = view.team.can.editCapacity;
  const refresh = () => refreshQueriesAfterMutation(queryClient, ["plan"]);
  const removal = useDeleteConfirm<CapacityPeriod>({
    mutationFn: (period) => deleteCapacityPeriod(period.id),
    onSuccess: refresh,
    successMessage: t("teams.view.toast.periodDeleted"),
  });
  return (
    <Stack gap="xs">
      <Group gap="sm" align="center" justify="space-between">
        <Title order={3} size="h4">
          {t("teams.view.capacityTitle")}
        </Title>
        {canEdit && (
          <Button variant="default" size="compact-md" leftSection={<IconPlus size={16} />} onClick={() => setEditor({ kind: "create" })}>
            {t("teams.view.action.addPeriod")}
          </Button>
        )}
      </Group>
      {periods.length === 0 ? (
        <EmptyState icon={IconGauge} label={t("teams.view.noCapacity")} hint={t(canEdit ? "teams.view.noCapacityHint" : "teams.view.noCapacityHintReadOnly")} />
      ) : (
        <>
          <Text size="sm" c="dimmed">
            {t("teams.view.capacityIntro")}
          </Text>
          <ScrollRegion label={t("teams.view.capacityAria")} minWidth={520}>
            <Table aria-label={t("teams.view.capacityAria")}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("teams.view.period.effectiveFrom")}</Table.Th>
                  <Table.Th>{t("teams.view.period.mdPerWeek")}</Table.Th>
                  <Table.Th>{t("teams.view.period.wipLimit")}</Table.Th>
                  <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {periods.map((period) => (
                  <Table.Tr key={period.id}>
                    <Table.Td>{period.effectiveFrom}</Table.Td>
                    <Table.Td>{period.mdPerWeek}</Table.Td>
                    <Table.Td>{period.wipLimit ?? "—"}</Table.Td>
                    <Table.Td style={{ width: 1 }} ta="right">
                      {canEdit && (
                        <RowActionsMenu label={t("common.table.operationsAria", { name: period.effectiveFrom })}>
                          <Menu.Item
                            leftSection={<IconPencil size={14} />}
                            onClick={() => setEditor({ kind: "edit", period })}
                            aria-label={t("teams.view.action.editPeriod", { date: period.effectiveFrom })}
                          >
                            {t("common.action.edit")}
                          </Menu.Item>
                          <Menu.Item
                            color="red"
                            leftSection={<IconTrash size={14} />}
                            onClick={() => removal.requestDelete(period)}
                            aria-label={t("teams.view.action.deletePeriod", { date: period.effectiveFrom })}
                          >
                            {t("common.action.delete")}
                          </Menu.Item>
                        </RowActionsMenu>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollRegion>
        </>
      )}
      {editor !== null && (
        <CapacityPeriodModal
          teamId={view.team.id}
          target={editor.kind === "edit" ? editor.period : null}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            setEditor(null);
            await refresh();
          }}
        />
      )}
      <ConfirmDeleteModal
        confirm={removal}
        title={t("teams.view.period.deleteTitle")}
        errorTitle={t("teams.view.period.deleteFailed")}
        errorMessage={(error) =>
          saveErrorMessage(error, t, {
            forbidden: "teams.view.saveForbidden",
            notFound: "teams.view.saveGone",
            failedStatus: "common.error.actionFailedStatus",
            failed: "common.error.actionFailed",
          })
        }
        body={(period) => t("teams.view.period.deleteBody", { date: period.effectiveFrom })}
      />
    </Stack>
  );
}
