import { useRef, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { Anchor, Button, Group, Stack, Table, Text, Title } from "@mantine/core";
import { IconLink, IconUsersGroup } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFlowTeamBinding, deleteFlowTeamBinding, listFlowTeams, matchFlowTeams, type FlowConnection, type FlowTeamListItem, type FlowTeamMatch } from "../api/flow";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { formatDateTime } from "../utils/formatDate";
import { linkFailure } from "../utils/flowLinkFailure";
import { refreshFlowLinks } from "../utils/flowRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { teamPath } from "../utils/teamLinks";
import { IDLE_REFRESH_MS } from "../utils/syncRuns";
import { showSuccessToast } from "../utils/toast";
import ConfirmDeleteModal from "./ConfirmDeleteModal";
import EmptyState from "./EmptyState";
import ErrorAlert from "./ErrorAlert";
import FormErrorAlert from "./FormErrorAlert";
import LoadingBlock from "./LoadingBlock";
import ScrollRegion from "./ScrollRegion";

/** The outcome of "Link all suggested": how many were linked and what was left (the server reports `NO_MATCH` / `ALREADY_BOUND` per Flow team). */
function matchSummary(result: FlowTeamMatch, t: TFunction): string {
  return t("flow.teams.matchResult", {
    linked: result.bound.length,
    noMatch: result.skipped.filter((s) => s.reason === "NO_MATCH").length,
    already: result.skipped.filter((s) => s.reason === "ALREADY_BOUND").length,
  });
}

/**
 * The connection page's **Teams** section: the Flow teams the last run mirrored (memberships and sprints counted), each with the Astrolabe team
 * it is linked to (a link to that team's page, and Unlink) or the one unbound team whose name matches (the server's suggestion, with a Link
 * button), "Link all suggested" for every unique suggestion at once, and when the mirror was read. Before the first run it says to refresh the
 * connection first. The list is the server's; the suggestion is never computed here. A link calls Flow never.
 */
export default function FlowTeamsSection({ connection }: { connection: FlowConnection }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [failure, setFailure] = useState<ReactNode>(null);
  const [matchNote, setMatchNote] = useState<string | null>(null);

  // Re-read slowly while the page is visible: a scheduled run replaces the mirror without anyone clicking.
  const teams = useQuery({ queryKey: ["flow", "teams", connection.id], queryFn: () => listFlowTeams(connection.id), refetchInterval: IDLE_REFRESH_MS });
  const items = teams.data?.items ?? [];
  const suggested = items.filter((team) => team.suggestedTeamId !== null);

  // The button that was pressed turns into another (Link -> Unlink) or goes (Link all -> disabled) once the list is re-read, which would drop the
  // focus on the document: the section's heading is the stable place (the unlink dialog does the same through `focusAfterDelete`).
  const focusHeading = () => headingRef.current?.focus({ preventScroll: true });

  const link = useMutation({
    mutationFn: (team: FlowTeamListItem) => createFlowTeamBinding({ connectionId: connection.id, flowTeamId: team.flowTeamId, teamId: team.suggestedTeamId! }),
    onMutate: () => {
      setFailure(null);
      setMatchNote(null);
    },
    onSuccess: () => {
      showSuccessToast(t("flow.toast.linked"));
      focusHeading();
    },
    onError: (err) => setFailure(linkFailure(err, t)),
    // A refused link usually means the list was stale (the team was linked meanwhile): re-read either way.
    onSettled: () => refreshFlowLinks(queryClient),
  });
  const match = useMutation({
    mutationFn: () => matchFlowTeams(connection.id),
    onMutate: () => {
      setFailure(null);
      setMatchNote(null);
    },
    onSuccess: (result) => {
      setMatchNote(matchSummary(result, t));
      focusHeading();
    },
    onError: (err) => setFailure(saveErrorMessage(err, t, { forbidden: "flow.saveForbidden", notFound: "flow.saveGone", invalid: "flow.teams.linkInvalid", failed: "flow.teams.matchFailed" })),
    onSettled: () => refreshFlowLinks(queryClient),
  });
  const unlink = useDeleteConfirm<FlowTeamListItem>({
    mutationFn: (team) => deleteFlowTeamBinding(team.bindingId!),
    onSuccess: () => {
      // The outcome line and any refusal described the list as it was; the unlink moves it again.
      setMatchNote(null);
      setFailure(null);
      return refreshFlowLinks(queryClient);
    },
    successMessage: t("flow.toast.unlinked"),
    focusAfterDelete: headingRef,
  });

  const busy = link.isPending || match.isPending;
  // A bind goes through an ENABLED connection only (the server answers 400 otherwise): say so rather than offer a button that fails.
  const canLink = connection.enabled && !busy;
  const label = t("flow.teams.tableAria");

  return (
    <Stack gap="md">
      <Title order={3} size="h4" ref={headingRef} tabIndex={-1}>
        {t("flow.teams.title")}
      </Title>
      <Text size="sm" c="dimmed">
        {t("flow.teams.intro")}
      </Text>

      {teams.isLoading ? (
        <LoadingBlock />
      ) : teams.isError ? (
        <ErrorAlert error={teams.error} title={t("flow.teams.loadFailed")} />
      ) : teams.data?.teamsAt == null ? (
        <EmptyState icon={IconUsersGroup} label={t("flow.teams.empty")} hint={t("flow.teams.emptyHint")} />
      ) : (
        <>
          <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
            <Stack gap={2}>
              <Text size="sm">{t("flow.teams.summary", { teams: items.length, linked: items.filter((team) => team.bindingId !== null).length, suggested: suggested.length })}</Text>
              <Text size="xs" c="dimmed">
                {t("flow.teams.observedAt")}: {formatDateTime(teams.data.teamsAt)}
              </Text>
            </Stack>
            <Button variant="default" leftSection={<IconLink size={16} />} loading={match.isPending} disabled={!canLink || suggested.length === 0} onClick={() => match.mutate()}>
              {t("flow.teams.linkAll")}
            </Button>
          </Group>
          {!connection.enabled && (
            <Text size="sm" c="dimmed" role="note">
              {t("flow.teams.disabledNote")}
            </Text>
          )}
          {failure && <FormErrorAlert>{failure}</FormErrorAlert>}
          <div role="status" aria-live="polite">
            {matchNote && <Text size="sm">{matchNote}</Text>}
          </div>
          <ScrollRegion label={label} minWidth={720}>
            <Table aria-label={label}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("flow.teams.column.name")}</Table.Th>
                  <Table.Th ta="right">{t("flow.teams.column.members")}</Table.Th>
                  <Table.Th ta="right">{t("flow.teams.column.sprints")}</Table.Th>
                  <Table.Th>{t("flow.teams.column.linked")}</Table.Th>
                  <Table.Th aria-label={t("flow.teams.column.actions")} style={{ width: 1 }} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((team) => (
                  <Table.Tr key={team.flowTeamId}>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {team.name}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">{team.members}</Table.Td>
                    <Table.Td ta="right">{team.sprints}</Table.Td>
                    <Table.Td>
                      {team.boundTeamId !== null ? (
                        <Anchor component={RouterLink} to={teamPath(team.boundTeamId)} size="sm">
                          {team.boundTeamName}
                        </Anchor>
                      ) : team.suggestedTeamId !== null ? (
                        <Text size="sm">{t("flow.teams.suggested", { name: team.suggestedTeamName })}</Text>
                      ) : (
                        <Text size="sm" c="dimmed">
                          {t("flow.teams.noMatch")}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td style={{ width: 1, whiteSpace: "nowrap" }} ta="right">
                      {team.bindingId !== null ? (
                        <Button variant="subtle" size="compact-sm" aria-label={t("flow.teams.unlinkAria", { flowTeam: team.name })} onClick={() => unlink.requestDelete(team)}>
                          {t("flow.teams.unlink")}
                        </Button>
                      ) : team.suggestedTeamId !== null ? (
                        <Button
                          variant="light"
                          size="compact-sm"
                          aria-label={t("flow.teams.linkAria", { flowTeam: team.name, team: team.suggestedTeamName })}
                          disabled={!canLink}
                          loading={link.isPending && link.variables?.flowTeamId === team.flowTeamId}
                          onClick={() => link.mutate(team)}
                        >
                          {t("flow.teams.link")}
                        </Button>
                      ) : null}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollRegion>
        </>
      )}

      <ConfirmDeleteModal
        confirm={unlink}
        title={t("flow.teams.unlinkTitle")}
        errorTitle={t("flow.teams.unlinkFailed")}
        confirmLabel={t("flow.teams.unlink")}
        errorMessage={(err) =>
          saveErrorMessage(err, t, { forbidden: "flow.teams.unlinkForbidden", notFound: "flow.teams.unlinkGone", failedStatus: "common.error.actionFailedStatus", failed: "common.error.actionFailed" })
        }
        body={(team) => t("flow.teams.unlinkBody", { team: team.boundTeamName, flowTeam: team.name })}
      />
    </Stack>
  );
}
