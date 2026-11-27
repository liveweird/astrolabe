import { Fragment, useEffect, useId, useRef, useState } from "react";
import { Alert, Button, Group, Stack, Text, Title } from "@mantine/core";
import { IconBookmark, IconCheck, IconRefresh, IconWand, IconX } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SAVED_PROPOSALS_KEY } from "../api/savedProposals";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { MAX_RUN_TEAMS, type OverviewProposal } from "../hooks/useOverviewProposal";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import CrossTeamRunView from "./CrossTeamRunView";
import EntityLink from "./EntityLink";
import FormErrorAlert from "./FormErrorAlert";
import OverviewProposalProjects from "./OverviewProposalProjects";
import SaveProposalModal from "./SaveProposalModal";
import ProposalNotes from "./TeamProposalNotes";

/**
 * The Roadmap overview's schedule proposal under the timeline (1.33; `useOverviewProposal` holds the state): a row with Propose (never automatic) and what it would
 * cover, then, while a run is requested or open, its section - the teams it covers, the projects whose dates would move, the run's own sections (`CrossTeamRunView`:
 * only the teams the viewer may accept have ticks), and the buttons. A viewer who may accept nothing previews: no Accept, no Save, no check is asked. Save needs the
 * viewer to be allowed to accept EVERY team of the run (the server's save guard is unchanged). Every taken step is said into the page's one polite region (`announce`);
 * the notes are visible only.
 */
export default function OverviewProposalSection({ proposal, announce }: { proposal: OverviewProposal; announce: (text: string) => void }) {
  const { t } = useTranslation();
  const { flow, rights, run, check, teamIds, tooMany, proposable, unsettled } = proposal;
  const { proposeRef, discardRef } = proposal.focus;
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  useDialogFocus(saving);
  // The accept button held the focus and is disabled while the write runs, so a failure would leave it on the body: it goes to the alert.
  const errorRef = useRef<HTMLDivElement>(null);
  const { error } = flow;
  useEffect(() => {
    if (error && run !== null) errorRef.current?.focus();
  }, [error, run]);

  const busy = flow.requesting || flow.applying;
  const canSave = flow.canAccept && run !== null && run.teams.every((team) => rights.acceptable.has(team.teamId));
  const hintId = useId();
  // Why Propose is (not) available, in the order the reasons arrive: the request, the rights read, the narrowing the address names, the size of the team set.
  const hint = flow.requesting
    ? t("programs.proposal.requesting")
    : !rights.ready
      ? t("programs.proposal.checking")
      : unsettled
        ? t("programs.proposal.settling")
        : tooMany
          ? t("programs.proposal.tooMany", { count: teamIds.length, max: MAX_RUN_TEAMS })
          : teamIds.length === 0
            ? t("programs.proposal.noTeams")
            : t("programs.proposal.covers", { count: teamIds.length });
  return (
    <Stack gap="sm">
      <Group gap="sm" align="center" wrap="wrap" data-print="hide">
        <Button ref={proposeRef} variant="default" size="xs" leftSection={<IconWand size={14} />} loading={flow.requesting} disabled={!proposable} aria-describedby={!proposable && run === null ? hintId : undefined} onClick={proposal.propose}>
          {t("programs.proposal.propose")}
        </Button>
        {run === null && (
          <Text id={hintId} size="sm" c="dimmed">
            {hint}
          </Text>
        )}
      </Group>
      {/* A first rights read that failed leaves nothing acceptable (the hook's `ready` degrades to a preview): say so (a failed refetch that kept its list says nothing). */}
      {rights.error !== null && rights.acceptable.size === 0 && (
        <Alert color="orange" variant="light" role="note">
          {t("programs.proposal.rightsFailed")}
        </Alert>
      )}
      {flow.refused && (
        <Alert color="orange" variant="light" role="note">
          {t("project.busy")}
        </Alert>
      )}
      <ProposalNotes proposal={flow} />
      {run !== null && (
        <Stack gap="md">
          <Title order={3} size="h4">
            {t("programs.proposal.title")}
          </Title>
          <Text size="sm" role="note">
            {t("programs.proposal.teams", { count: run.teams.length })}{" "}
            {run.teams.map((team, index) => (
              <Fragment key={team.teamId}>
                {index > 0 && ", "}
                <EntityLink entity={{ kind: "team", id: team.teamId }} name={team.name} underline="always" />
              </Fragment>
            ))}
            {t("programs.proposal.kept")}
          </Text>
          <Text size="sm" c="dimmed">
            {t("programs.proposal.intro")}
          </Text>
          <OverviewProposalProjects projects={run.projects} />
          <CrossTeamRunView
            run={run}
            check={check}
            selected={flow.selected}
            applying={flow.applying}
            onToggle={flow.toggle}
            onSelectAll={flow.selectAll}
            onSelectNone={flow.selectNone}
            acceptable={rights.acceptable}
          />
          {error && (
            <FormErrorAlert ref={errorRef} tabIndex={-1}>
              {error}
            </FormErrorAlert>
          )}
          <Group gap="sm">
            {canSave && (
              <Button leftSection={<IconBookmark size={16} />} variant="default" disabled={flow.selected.size === 0 || busy} onClick={() => setSaving(true)}>
                {t("scheduleProposals.saved.save")}
              </Button>
            )}
            {flow.canAccept && (
              <Button leftSection={<IconCheck size={16} />} loading={flow.applying} disabled={flow.selected.size === 0 || busy} onClick={flow.accept}>
                {t("teams.proposal.accept", { count: flow.selected.size })}
              </Button>
            )}
            <Button variant="default" leftSection={<IconRefresh size={16} />} disabled={busy} onClick={() => flow.proposeAgain(run.teams.map((team) => team.teamId), flow.selected, false)}>
              {t("programs.proposal.again")}
            </Button>
            <Button ref={discardRef} variant="default" leftSection={<IconX size={16} />} disabled={flow.applying} onClick={flow.discard}>
              {t("teams.proposal.discard")}
            </Button>
          </Group>
        </Stack>
      )}
      {saving && run !== null && (
        <SaveProposalModal
          run={run}
          selected={flow.selected}
          onClose={() => setSaving(false)}
          onSaved={async () => {
            setSaving(false);
            announce(t("scheduleProposals.saved.toast.saved"));
            await refreshQueriesAfterMutation(queryClient, [...SAVED_PROPOSALS_KEY]);
          }}
          onProposeAgain={() => {
            setSaving(false);
            flow.proposeAgain(run.teams.map((team) => team.teamId), flow.selected);
          }}
        />
      )}
    </Stack>
  );
}
