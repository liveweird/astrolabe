import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { Anchor, Button, Menu, Stack, Table, Text } from "@mantine/core";
import { IconCamera, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { BASELINE_CAP, deleteBaseline, type Baseline } from "../api/baselines";
import { ApiError } from "../api/http";
import BaselineEditorModal from "../components/BaselineEditorModal";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import PageHeader from "../components/PageHeader";
import RowActionsMenu from "../components/RowActionsMenu";
import ScrollRegion from "../components/ScrollRegion";
import TableLoadingRow from "../components/TableLoadingRow";
import { useBaselines } from "../hooks/useBaselines";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { baselinePath } from "../utils/baselineLinks";
import { formatDateTime } from "../utils/formatDate";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";

const NO_WRAP = { whiteSpace: "nowrap" } as const;

/**
 * The Baselines registry (`/baselines`): the named, frozen copies of the plan, newest first. Everyone signed in reads the list (a baseline's
 * name opens its comparison with the plan); `can.manage` (ADMIN or a ROADMAP_EDITOR, the server's own arithmetic — never the session's
 * roles) adds "Take baseline" and the row menu (Rename…, Delete). The list is a bounded set (at most 100), so it is one unpaged table —
 * no pager, no filters — in a `ScrollRegion`. Every write bumps the plan revision, so it refreshes the plan views as well as the list.
 */
export default function Baselines() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { items, can, loading, error } = useBaselines();
  const [editorTarget, setEditorTarget] = useState<Baseline | "new" | null>(null);

  const refresh = () => refreshQueriesAfterMutation(queryClient, ["baselines"], ["plan"], ["roadmap"]);
  const remove = useDeleteConfirm<Baseline>({
    mutationFn: async (row) => {
      try {
        await deleteBaseline(row.id);
      } catch (err) {
        // 404: someone else deleted it first. The row is stale, so reload the list (the dialog still says it is gone).
        if (err instanceof ApiError && err.status === 404) await refresh();
        throw err;
      }
    },
    onSuccess: refresh,
    successMessage: t("baselines.toast.deleted"),
  });

  const columnCount = 8;
  const atCap = items.length >= BASELINE_CAP;

  return (
    <Stack gap="md">
      <PageHeader
        title={t("baselines.title")}
        description={t("baselines.intro")}
        actions={
          can.manage && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setEditorTarget("new")}>
              {t("baselines.takeBaseline")}
            </Button>
          )
        }
      />

      {error !== null && <ErrorAlert error={error} title={t("baselines.loadFailed")} />}

      {!loading && error === null && (
        <Text size="sm" c="dimmed" role="status">
          {atCap ? t("baselines.capReached", { max: BASELINE_CAP }) : t("baselines.count", { count: items.length, max: BASELINE_CAP })}
        </Text>
      )}

      <ScrollRegion label={t("baselines.tableAria")} minWidth={960}>
        <Table aria-label={t("baselines.tableAria")}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("common.field.name")}</Table.Th>
              <Table.Th>{t("common.field.description")}</Table.Th>
              <Table.Th>{t("baselines.column.taken")}</Table.Th>
              <Table.Th ta="right">{t("baselines.column.revision")}</Table.Th>
              <Table.Th>{t("baselines.column.by")}</Table.Th>
              <Table.Th ta="right">{t("baselines.column.milestones")}</Table.Th>
              <Table.Th ta="right">{t("baselines.column.projects")}</Table.Th>
              <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {loading ? (
              <TableLoadingRow colSpan={columnCount} />
            ) : items.length > 0 ? (
              items.map((baseline) => (
                <Table.Tr key={baseline.id}>
                  <Table.Td>
                    {/* The name is the way into the comparison — a real link (the detail-link rule). */}
                    <Anchor component={RouterLink} to={baselinePath(baseline.id)} fw={500} size="sm" aria-label={t("baselines.openAria", { name: baseline.name })}>
                      {baseline.name}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c={baseline.description ? undefined : "dimmed"} lineClamp={1}>
                      {baseline.description ?? "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td style={NO_WRAP}>{formatDateTime(baseline.createdAt)}</Table.Td>
                  <Table.Td ta="right">{baseline.planRevision}</Table.Td>
                  <Table.Td>
                    <Text size="sm" c={baseline.createdBy ? undefined : "dimmed"}>
                      {baseline.createdBy?.name ?? "—"}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">{baseline.milestoneCount}</Table.Td>
                  <Table.Td ta="right">{baseline.projectCount}</Table.Td>
                  <Table.Td style={{ width: 1 }} ta="right">
                    {can.manage && (
                      <RowActionsMenu label={t("common.table.operationsAria", { name: baseline.name })}>
                        <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => setEditorTarget(baseline)} aria-label={t("baselines.renameAria", { name: baseline.name })}>
                          {t("baselines.rename")}
                        </Menu.Item>
                        <Menu.Divider />
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          onClick={() => remove.requestDelete(baseline)}
                          aria-label={t("common.action.deleteAria", { name: baseline.name })}
                        >
                          {t("common.action.delete")}
                        </Menu.Item>
                      </RowActionsMenu>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))
            ) : error === null ? (
              <Table.Tr>
                <Table.Td colSpan={columnCount}>
                  <EmptyState icon={IconCamera} label={t("baselines.empty")} hint={t(can.manage ? "baselines.emptyHint" : "baselines.emptyHintReadOnly")} />
                </Table.Td>
              </Table.Tr>
            ) : null}
          </Table.Tbody>
        </Table>
      </ScrollRegion>

      {editorTarget !== null && (
        <BaselineEditorModal
          target={editorTarget === "new" ? null : editorTarget}
          onClose={() => setEditorTarget(null)}
          onSaved={async () => {
            setEditorTarget(null);
            await refresh();
          }}
          onGone={refresh}
        />
      )}

      <ConfirmDeleteModal
        confirm={remove}
        title={t("baselines.deleteTitle")}
        errorTitle={t("baselines.deleteFailed")}
        errorMessage={(err) =>
          saveErrorMessage(err, t, {
            forbidden: "baselines.deleteForbidden",
            notFound: "baselines.deleteGone",
            failedStatus: "common.error.actionFailedStatus",
            failed: "common.error.actionFailed",
          })
        }
        body={(baseline) => t("baselines.deleteBody", { name: baseline.name })}
      />
    </Stack>
  );
}
