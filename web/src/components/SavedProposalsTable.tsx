import { useRef } from "react";
import { Anchor, Button, Stack, Table, Text, Title } from "@mantine/core";
import { IconBookmarks } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { deleteSavedProposal, listSavedProposals, savedProposalKey, savedProposalListKey, SAVED_PROPOSALS_KEY, type SavedProposalSummary } from "../api/savedProposals";
import { ApiError } from "../api/http";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { formatDateTime } from "../utils/formatDate";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { savedScheduleProposalPath } from "../utils/scheduleProposalLinks";
import ConfirmDeleteModal from "./ConfirmDeleteModal";
import CreatorName from "./CreatorName";
import EmptyState from "./EmptyState";
import ErrorAlert from "./ErrorAlert";
import ScrollRegion from "./ScrollRegion";
import TableLoadingRow from "./TableLoadingRow";

const NO_WRAP = { whiteSpace: "nowrap" } as const;
const COLUMNS = 7;

/**
 * The "Saved proposals" section of the schedule-proposals page (1.26): the newest 20 saved runs, newest first (a bounded set, one unpaged
 * table). Any signed-in user reads; a name opens the saved page, Delete shows by the row's own `can.delete` (the server's arithmetic, never the
 * session's roles). A delete is a hard delete and touches nothing of the plan.
 */
export default function SavedProposalsTable() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({ queryKey: savedProposalListKey, queryFn: listSavedProposals });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const refresh = () => refreshQueriesAfterMutation(queryClient, [...SAVED_PROPOSALS_KEY]);
  // A deleted proposal's own page must not keep a copy to open from the cache (it would offer an Accept for a proposal that is gone).
  const forget = (id: number) => queryClient.removeQueries({ queryKey: savedProposalKey(id) });
  const remove = useDeleteConfirm<SavedProposalSummary>({
    mutationFn: async (row) => {
      try {
        await deleteSavedProposal(row.id);
      } catch (err) {
        // 404: someone else deleted it first (or it was pruned). The row is stale, so reload the list; the dialog still says it is gone.
        if (err instanceof ApiError && err.status === 404) {
          forget(row.id);
          await refresh();
        }
        throw err;
      }
    },
    onSuccess: (row) => {
      forget(row.id);
      return refresh();
    },
    successMessage: t("scheduleProposals.saved.toast.deleted"),
    focusAfterDelete: headingRef,
  });
  const items = data?.items ?? [];
  const aria = t("scheduleProposals.saved.tableAria");

  return (
    <Stack gap="xs">
      <Title order={3} size="h4" ref={headingRef} tabIndex={-1}>
        {t("scheduleProposals.saved.title")}
      </Title>
      <Text size="sm" c="dimmed">
        {t("scheduleProposals.saved.intro")}
      </Text>
      {isError && <ErrorAlert error={error} title={t("scheduleProposals.saved.loadFailed")} />}
      <ScrollRegion label={aria} minWidth={880}>
        <Table aria-label={aria}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("common.field.name")}</Table.Th>
              <Table.Th>{t("scheduleProposals.saved.column.teams")}</Table.Th>
              <Table.Th>{t("scheduleProposals.saved.column.asOf")}</Table.Th>
              <Table.Th ta="right">{t("scheduleProposals.saved.column.moves")}</Table.Th>
              <Table.Th>{t("scheduleProposals.saved.column.by")}</Table.Th>
              <Table.Th>{t("scheduleProposals.saved.column.savedAt")}</Table.Th>
              <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {isLoading ? (
              <TableLoadingRow colSpan={COLUMNS} />
            ) : items.length > 0 ? (
              items.map((proposal) => (
                <Table.Tr key={proposal.id}>
                  <Table.Td>
                    <Anchor component={RouterLink} to={savedScheduleProposalPath(proposal.id)} fw={500} size="sm" aria-label={t("scheduleProposals.saved.openAria", { name: proposal.name })}>
                      {proposal.name}
                    </Anchor>
                  </Table.Td>
                  {/* The teams are the run's as named at the save: one may be gone since and the list has no state to say so, so they are text here; the saved page links them while it is current. */}
                  <Table.Td>{proposal.teams.map((team) => team.name).join(", ")}</Table.Td>
                  <Table.Td style={NO_WRAP}>{proposal.asOf}</Table.Td>
                  <Table.Td ta="right" style={NO_WRAP}>
                    {t("scheduleProposals.saved.moves", { selected: proposal.selectedCount, total: proposal.moveCount })}
                  </Table.Td>
                  <Table.Td>
                    <CreatorName creator={proposal.createdBy} />
                  </Table.Td>
                  <Table.Td style={NO_WRAP}>{formatDateTime(proposal.createdAt)}</Table.Td>
                  <Table.Td style={{ width: 1, whiteSpace: "nowrap" }} ta="right">
                    {proposal.can.delete && (
                      <Button variant="subtle" size="compact-sm" aria-label={t("common.action.deleteAria", { name: proposal.name })} onClick={() => remove.requestDelete(proposal)}>
                        {t("common.action.delete")}
                      </Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))
            ) : isError ? null : (
              <Table.Tr>
                <Table.Td colSpan={COLUMNS}>
                  <EmptyState icon={IconBookmarks} label={t("scheduleProposals.saved.empty")} hint={t("scheduleProposals.saved.emptyHint")} />
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </ScrollRegion>
      <ConfirmDeleteModal
        confirm={remove}
        title={t("scheduleProposals.saved.deleteTitle")}
        errorTitle={t("scheduleProposals.saved.deleteFailed")}
        errorMessage={(err) =>
          saveErrorMessage(err, t, {
            forbidden: "scheduleProposals.saved.deleteForbidden",
            notFound: "scheduleProposals.saved.deleteGone",
            failedStatus: "common.error.actionFailedStatus",
            failed: "common.error.actionFailed",
          })
        }
        body={(proposal) => t("scheduleProposals.saved.deleteBody", { name: proposal.name })}
      />
    </Stack>
  );
}
