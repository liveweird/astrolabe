import { Fragment, useEffect, useRef, type Ref } from "react";
import { Alert, Button, Group, Stack, Text, Title } from "@mantine/core";
import { IconCheck, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TeamProposals } from "../hooks/useTeamProposals";
import { ANCHORED_HEADING_STYLE } from "../utils/layout";
import CrossTeamRunView from "./CrossTeamRunView";
import EntityLink from "./EntityLink";
import FormErrorAlert from "./FormErrorAlert";

/**
 * The cross-team run planned from the team page (1.38, `useTeamProposals` holds the state): an h3 after the timeline - the teams it covers, what the dashed bars and the dimmed rows
 * show, then the run's own sections (`CrossTeamRunView`, in placement order: this team's and the other teams'). The moves of this team and of every other run team the viewer may accept are
 * ticked and tickable; the other teams' sections are a read-only preview ("Shown as it would be if this team's manager accepts…"). Accept selected takes the ticked moves of every
 * acceptable team in the run's one accept; Discard closes it. No Save here (the Roadmap overview's). The page's one polite status region says each taken step (the hook announces).
 * The heading takes the focus when the run opens (`headingRef`, `useProposalFocus`).
 */
export default function TeamRunSection({ proposal, busy, headingRef }: { proposal: TeamProposals; busy: boolean; headingRef: Ref<HTMLHeadingElement> }) {
  const { t } = useTranslation();
  const { run, together, rights, check, error } = proposal;
  // The accept button held the focus and is disabled while the write runs, so a failure would leave it on the body: it goes to the alert.
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  if (run === null) return null;
  return (
    <Stack gap="md">
      <Title order={3} size="h4" ref={headingRef} tabIndex={-1} style={ANCHORED_HEADING_STYLE}>
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
        {together.canAccept ? t("teams.run.intro") : t("teams.run.introPreview")}
      </Text>
      {/* A first rights read that failed leaves nothing acceptable (the run is a preview): say so, as the overview and the project page do. */}
      {rights.error !== null && rights.acceptable.size === 0 && (
        <Alert color="orange" variant="light" role="note">
          {t("programs.proposal.rightsFailed")}
        </Alert>
      )}
      <CrossTeamRunView
        run={run}
        check={check}
        selected={together.selected}
        applying={together.applying}
        onToggle={together.toggle}
        onSelectAll={together.selectAll}
        onSelectNone={together.selectNone}
        acceptable={rights.acceptable}
        openTeamId={proposal.proposal?.teamId}
      />
      {error && (
        <FormErrorAlert ref={errorRef} tabIndex={-1}>
          {error}
        </FormErrorAlert>
      )}
      <Group gap="sm">
        {together.canAccept && (
          <Button leftSection={<IconCheck size={16} />} loading={together.applying} disabled={together.selected.size === 0 || busy} onClick={together.accept}>
            {t("teams.proposal.accept", { count: together.selected.size })}
          </Button>
        )}
        <Button variant="default" leftSection={<IconX size={16} />} disabled={together.applying} onClick={together.discard}>
          {t("teams.proposal.discard")}
        </Button>
      </Group>
    </Stack>
  );
}
