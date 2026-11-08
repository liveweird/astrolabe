import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Group, Modal, Select, Stack, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFlowTeamBinding, listFlowTeams, type FlowPanelConnection } from "../api/flow";
import { ApiError } from "../api/http";
import { linkFailure } from "../utils/flowLinkFailure";
import { refreshFlowLinks } from "../utils/flowRefresh";
import { loadErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";
import FormErrorAlert from "./FormErrorAlert";

/**
 * Link this team to a Flow team (`POST /integrations/flow/team-bindings`): an ENABLED connection, then one of its UNLINKED Flow teams, the
 * one whose name matches this team (the server's suggestion, never computed here) preselected. A link calls Flow never - it reads the mirror.
 * The connections come from the team's Flow panel (`connections`, every active one by name, for any login: the registry itself is ADMIN only),
 * and only the enabled ones are offered - with exactly one, it is preselected. Every failure is an inline alert (`linkFailure`: a fixed lead and
 * the server's sentence for a 400 / 409); the choice is kept.
 */
export default function FlowTeamLinkDialog({ team, connections, onClose, onLinked }: { team: { id: number; name: string }; connections: readonly FlowPanelConnection[]; onClose: () => void; onLinked: () => Promise<void> }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [chosenConnection, setChosenConnection] = useState<string | null>(null);
  const [chosenTeam, setChosenTeam] = useState<string | null>(null);
  const [failure, setFailure] = useState<ReactNode>(null);
  const [submitting, setSubmitting] = useState(false);

  const offered = connections.filter((connection) => connection.enabled);
  const connectionId = chosenConnection ?? (offered.length === 1 ? String(offered[0].id) : null);

  // The same key as the connection page's Teams section, so a link refreshes both through `refreshFlowLinks`.
  const flowTeams = useQuery({
    queryKey: ["flow", "teams", Number(connectionId)],
    queryFn: () => listFlowTeams(Number(connectionId)),
    enabled: connectionId !== null,
  });
  const unlinked = (flowTeams.data?.items ?? []).filter((flowTeam) => flowTeam.bindingId === null);
  const suggestion = unlinked.find((flowTeam) => flowTeam.suggestedTeamId === team.id) ?? null;
  // A choice the list no longer offers (re-read after a refusal) is no choice.
  const stillOffered = chosenTeam !== null && unlinked.some((flowTeam) => String(flowTeam.flowTeamId) === chosenTeam);
  const teamId = stillOffered ? chosenTeam : suggestion === null ? null : String(suggestion.flowTeamId);
  const mirrored = flowTeams.data?.teamsAt != null;

  async function submit() {
    if (submitting || connectionId === null || teamId === null) return;
    setFailure(null);
    setSubmitting(true);
    try {
      await createFlowTeamBinding({ connectionId: Number(connectionId), flowTeamId: Number(teamId), teamId: team.id });
      showSuccessToast(t("flow.toast.linked"));
      await onLinked();
    } catch (err) {
      setFailure(linkFailure(err, t));
      setSubmitting(false);
      // A 409 / 400 usually means the list was stale (linked meanwhile, or gone from the mirror): re-read it so the stale option goes.
      if (err instanceof ApiError && (err.status === 409 || err.status === 400)) void refreshFlowLinks(queryClient);
    }
  }

  const connectionNote =
    offered.length === 0 ? (
      <Text size="sm" role="note">
        {t(connections.length > 0 ? "flow.link.noEnabledConnection" : "flow.link.noConnection")}
      </Text>
    ) : null;

  return (
    <Modal
      closeButtonProps={{ "aria-label": t("common.action.close") }}
      // While the request is in flight the dialog stays: closing it would hide the outcome of a link that still lands.
      withCloseButton={!submitting}
      closeOnEscape={!submitting}
      closeOnClickOutside={!submitting}
      opened
      onClose={onClose}
      title={t("flow.link.title")}
      centered
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        noValidate
      >
        <Stack>
          <Text size="sm" c="dimmed">
            {t("flow.link.intro", { team: team.name })}
          </Text>
          {connectionNote}
          {offered.length > 0 && (
            <Select
              label={t("flow.link.connection")}
              data={offered.map((connection) => ({ value: String(connection.id), label: connection.name }))}
              value={connectionId}
              onChange={(value) => {
                setChosenConnection(value);
                setChosenTeam(null);
              }}
              allowDeselect={false}
              readOnly={offered.length === 1}
              data-autofocus
            />
          )}
          {connectionId !== null && flowTeams.isLoading && <Text size="sm">{t("flow.link.loading")}</Text>}
          {flowTeams.isError && <FormErrorAlert>{loadErrorMessage(flowTeams.error, t)}</FormErrorAlert>}
          {flowTeams.isSuccess && !mirrored && (
            <Alert color="orange" variant="light" role="note">
              {t("flow.link.notRead")}
            </Alert>
          )}
          {flowTeams.isSuccess && mirrored && (
            <>
              <Select
                label={t("flow.link.flowTeam")}
                placeholder={t("flow.link.flowTeamPlaceholder")}
                description={suggestion === null ? t("flow.link.noSuggestion") : t("flow.link.suggestionHint")}
                data={unlinked.map((flowTeam) => ({ value: String(flowTeam.flowTeamId), label: flowTeam.suggestedTeamId === team.id ? t("flow.link.suggestedMark", { name: flowTeam.name }) : flowTeam.name }))}
                value={teamId}
                onChange={setChosenTeam}
                allowDeselect={false}
                searchable
                nothingFoundMessage={t("flow.link.nothingFound")}
              />
              {unlinked.length === 0 && (
                <Text size="sm" role="note">
                  {t("flow.link.allLinked")}
                </Text>
              )}
            </>
          )}
          {failure && <FormErrorAlert>{failure}</FormErrorAlert>}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={onClose} disabled={submitting}>
              {t("common.action.cancel")}
            </Button>
            <Button type="submit" loading={submitting} disabled={connectionId === null || teamId === null}>
              {t("flow.link.submit")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
