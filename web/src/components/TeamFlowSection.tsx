import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Group, Stack, Table, Text, Title } from "@mantine/core";
import { IconDownload, IconLink, IconLinkOff } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteFlowTeamBinding, getTeamFlow, type FlowPanelBinding } from "../api/flow";
import { staleFlowConnection } from "../utils/capacityDeviations";
import { useCapacityDeviations } from "../hooks/useCapacityDeviations";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useNow } from "../hooks/useNow";
import { refreshFlowLinks } from "../utils/flowRefresh";
import { formatDateTime } from "../utils/formatDate";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { IDLE_REFRESH_MS } from "../utils/syncRuns";
import CapacityImportModal from "./CapacityImportModal";
import { CapacityDetails, CapacityFact, type CapacityComparison } from "./TeamFlowCapacity";
import ConfirmDeleteModal from "./ConfirmDeleteModal";
import ErrorAlert from "./ErrorAlert";
import { Fact } from "./SyncFacts";
import FlowRosterPanel from "./FlowRosterPanel";
import FlowTeamLinkDialog from "./FlowTeamLinkDialog";
import LoadingBlock from "./LoadingBlock";
import SyncStatusBadge from "./SyncStatusBadge";

/**
 * The team page's **Flow** section (`GET /teams/{id}/flow` under `["flow","team",id]`, its own read - not a member of the team view): not linked
 * ("Link to Flow team…"), or linked - the Flow team, its connection with the sync status, when the mirror last saw it (an orange "No longer in
 * Flow" when it left the document, a note while the connection is disabled), **Import capacity…**, **Unlink** (an in-page confirm) and the
 * observed roster, and its **Capacity vs Flow** row and lines (`TeamFlowCapacity`, from the Deviations document asked for this team). What each control offers is the panel's `can`, never the session's roles. `importBlocked` (a schedule proposal is open) keeps
 * the capacity import closed: a capacity change would void the proposal's premise. Nothing here calls Flow.
 */
export default function TeamFlowSection({ teamId, importBlocked = false }: { teamId: number; importBlocked?: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [linking, setLinking] = useState(false);
  const [importing, setImporting] = useState(false);
  useDialogFocus(linking || importing);

  // Slow re-read while the page is visible: a scheduled run changes the status, the roster and the "gone" verdict without a click.
  const panel = useQuery({ queryKey: ["flow", "team", teamId], queryFn: () => getTeamFlow(teamId), refetchInterval: IDLE_REFRESH_MS });
  const now = useNow(60_000, panel.dataUpdatedAt);
  const unlink = useDeleteConfirm<FlowPanelBinding>({
    mutationFn: (binding) => deleteFlowTeamBinding(binding.id),
    onSuccess: () => refreshFlowLinks(queryClient),
    successMessage: t("flow.toast.unlinked"),
    focusAfterDelete: headingRef,
  });

  // The plan's capacity against Flow's, for this team alone (the Deviations page's document); only a linked team has anything to compare.
  const linked = panel.data?.binding ?? null;
  const deviations = useCapacityDeviations({ teamId }, { enabled: linked !== null, idleRefresh: true });
  const comparison: CapacityComparison = {
    rows: deviations.data === undefined ? undefined : (deviations.data.items.find((item) => item.team.id === teamId)?.deviations ?? []),
    failed: deviations.isError,
    error: deviations.error,
    // Agreement is only claimed for a connection that is enabled and CURRENT; a team whose Flow was never mirrored has neither.
    current: linked !== null && !staleFlowConnection({ enabled: linked.connectionEnabled, status: linked.status }),
  };

  // An open proposal (or one being requested) closes the import and does not let it come back on its own.
  if (importBlocked && importing) setImporting(false);

  const data = panel.data;
  const binding = data?.binding ?? null;
  const can = data?.can;
  return (
    <Stack gap="xs">
      <Title order={3} size="h4" ref={headingRef} tabIndex={-1}>
        {t("flow.panel.title")}
      </Title>
      {/* A failed background re-read keeps what was read; the error alert is for a panel that never loaded. */}
      {data !== undefined && panel.isError && (
        <Text size="sm" c="dimmed" role="note">
          {t("flow.panel.stale")}
        </Text>
      )}
      {data === undefined ? (
        panel.isError ? <ErrorAlert error={panel.error} title={t("flow.panel.loadFailed")} /> : <LoadingBlock />
      ) : binding === null ? (
        <Stack gap="xs" align="flex-start">
          <Text size="sm" fw={500}>
            {t("flow.panel.notLinked")}
          </Text>
          <Text size="sm" c="dimmed">
            {t(can?.link ? "flow.panel.notLinkedHint" : "flow.panel.notLinkedReadOnly")}
          </Text>
          {can?.link && (
            <Button variant="default" size="compact-md" leftSection={<IconLink size={16} />} onClick={() => setLinking(true)}>
              {t("flow.panel.link")}
            </Button>
          )}
        </Stack>
      ) : (
        <Stack gap="sm">
          <Table aria-label={t("flow.panel.factsAria")}>
            <Table.Tbody>
              <Fact label={t("flow.panel.fact.flowTeam")}>
                <Group gap="xs" wrap="wrap">
                  <Text size="sm">{binding.flowTeamName}</Text>
                  {binding.gone && (
                    <Badge color="orange" variant="light" tt="none">
                      {t("flow.panel.gone")}
                    </Badge>
                  )}
                </Group>
              </Fact>
              <Fact label={t("flow.panel.fact.connection")}>{binding.connectionName}</Fact>
              <Fact label={t("flow.panel.fact.status")}>
                <SyncStatusBadge status={binding.status} now={now} />
              </Fact>
              <Fact label={t("flow.panel.fact.observedAt")}>{binding.observedAt === null ? "—" : formatDateTime(binding.observedAt)}</Fact>
              {!binding.gone && <CapacityFact comparison={comparison} />}
            </Table.Tbody>
          </Table>
          {!binding.gone && <CapacityDetails comparison={comparison} canImport={can?.importCapacity === true && !importBlocked} />}
          {binding.gone && (
            <Text size="sm" role="note">
              {t("flow.panel.goneNote")}
            </Text>
          )}
          {!binding.connectionEnabled && (
            <Text size="sm" c="dimmed" role="note">
              {t("flow.panel.disabledNote")}
            </Text>
          )}
          {data.sprints !== null && (
            <Text size="sm">{data.sprints.nextStart === null ? t("flow.panel.sprints", { n: data.sprints.count }) : t("flow.panel.sprintsNext", { n: data.sprints.count, date: data.sprints.nextStart })}</Text>
          )}
          {importBlocked && can?.importCapacity && (
            <Text size="sm" c="dimmed" role="note">
              {t("flow.panel.importBlocked")}
            </Text>
          )}
          <Group gap="sm">
            {can?.importCapacity && (
              <Button variant="default" size="compact-md" leftSection={<IconDownload size={16} />} disabled={binding.gone || importBlocked} onClick={() => setImporting(true)}>
                {t("flow.panel.importCapacity")}
              </Button>
            )}
            {can?.unlink && (
              <Button variant="subtle" size="compact-md" leftSection={<IconLinkOff size={16} />} onClick={() => unlink.requestDelete(binding)}>
                {t("flow.panel.unlink")}
              </Button>
            )}
          </Group>
          <FlowRosterPanel roster={data.roster} observedAt={binding.observedAt} />
        </Stack>
      )}

      {linking && data !== undefined && (
        <FlowTeamLinkDialog
          team={data.team}
          connections={data.connections}
          onClose={() => setLinking(false)}
          onLinked={async () => {
            setLinking(false);
            await refreshFlowLinks(queryClient);
            headingRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
      {importing && binding !== null && !importBlocked && (
        <CapacityImportModal binding={binding} onClose={() => setImporting(false)} onImported={() => refreshQueriesAfterMutation(queryClient, ["plan"], ["flow", "deviations"])} />
      )}
      <ConfirmDeleteModal
        confirm={unlink}
        title={t("flow.panel.unlinkTitle")}
        errorTitle={t("flow.panel.unlinkFailed")}
        confirmLabel={t("flow.panel.unlink")}
        errorMessage={(err) =>
          saveErrorMessage(err, t, { forbidden: "flow.teams.unlinkForbidden", notFound: "flow.teams.unlinkGone", failedStatus: "common.error.actionFailedStatus", failed: "common.error.actionFailed" })
        }
        body={(target) => t("flow.panel.unlinkBody", { flowTeam: target.flowTeamName, connection: target.connectionName })}
      />
    </Stack>
  );
}
