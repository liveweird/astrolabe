import { Fragment, useEffect, useId, useRef } from "react";
import { Alert, Button, Group, Stack, Text, Title } from "@mantine/core";
import { IconCheck, IconRefresh, IconWand, IconX } from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import type { ProjectProposal as ProjectProposalState } from "../hooks/useProjectProposal";
import { ANCHORED_HEADING_STYLE } from "../utils/layout";
import CrossTeamRunView from "./CrossTeamRunView";
import EntityLink from "./EntityLink";
import FormErrorAlert from "./FormErrorAlert";
import ProposalNotes from "./TeamProposalNotes";
import { TOOLBAR_CONTROL_SIZE } from "../utils/timelineModel";

/** What the run does to the project's own span, in one sentence (the server's `projects[]` entry, absent = its span stays). */
function projectSentence(entry: CrossTeamProposal["projects"][number] | undefined, t: TFunction): string {
  if (entry === undefined) return t("project.proposal.unchanged");
  if (entry.before === null || entry.endShiftDays === null) return t("project.proposal.newly", entry.after);
  const days = entry.endShiftDays;
  if (days === 0) return t("project.proposal.endSame", { end: entry.after.end });
  return t(days < 0 ? "project.proposal.endEarlier" : "project.proposal.endLater", { before: entry.before.end, after: entry.after.end, count: Math.abs(days) });
}

/**
 * The project page's schedule proposal (1.33; `useProjectProposal` holds the state): a row with Propose (a click, never automatic) and what it would cover, then, while a
 * run is requested or open, its section (an h3 after the tray) - the teams it covers, what the run does to the project's end, the run's own sections cut to this project
 * (`CrossTeamRunView` with `projectId`: only this project's moves have ticks, and only for the teams the viewer may accept) and the buttons. Accept takes the ticked moves of THIS
 * project only; the run's moves of the same teams in other projects are counted and their teams linked, not offered. No Save. A viewer who may accept nothing previews: no Accept,
 * no check is asked. The page's one polite status region says each taken step (`announce`); the notes are visible only.
 */
export default function ProjectProposal({ proposal, announce }: { proposal: ProjectProposalState; announce: (text: string) => void }) {
  const { t } = useTranslation();
  const { flow, rights, run, check, teamIds, others, proposable } = proposal;
  const { proposeRef, headingRef } = proposal.focus;
  const hintId = useId();
  // The accept button held the focus and is disabled while the write runs, so a failure would leave it on the body: it goes to the alert.
  const errorRef = useRef<HTMLDivElement>(null);
  const { error } = flow;
  useEffect(() => {
    if (error && run !== null) errorRef.current?.focus();
  }, [error, run]);
  const busy = flow.requesting || flow.applying;
  // Why Propose is (not) available, in the order the reasons arrive: the request, the rights read, no team.
  const hint = flow.requesting
    ? t("project.proposal.requesting")
    : !rights.ready
      ? t("programs.proposal.checking")
      : t("project.proposal.covers", { count: teamIds.length });
  return (
    <Stack gap="sm">
      <Group gap="sm" align="center" wrap="wrap" data-print="hide">
        <Button ref={proposeRef} variant="default" size={TOOLBAR_CONTROL_SIZE} leftSection={<IconWand size={14} />} loading={flow.requesting} disabled={!proposable} aria-describedby={!proposable && run === null ? hintId : undefined} onClick={proposal.propose}>
          {t("programs.proposal.propose")}
        </Button>
        {run === null && (
          <Text id={hintId} size="sm" c="dimmed">
            {hint}
          </Text>
        )}
      </Group>
      {/* A first rights read that failed leaves nothing acceptable (the hook's `ready` degrades to a preview): say so. */}
      {rights.error !== null && rights.acceptable.size === 0 && (
        <Alert color="orange" variant="light" role="note">
          {t("programs.proposal.rightsFailed")}
        </Alert>
      )}
      {proposal.refusal !== null && (
        <Alert color="orange" variant="light" role="note">
          {proposal.refusal}
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
          <Text size="sm" fw={500}>
            {projectSentence(proposal.preview?.project, t)}
          </Text>
          <Text size="sm" c="dimmed">
            {t("project.proposal.intro")}
          </Text>
          {others.count > 0 && (
            <Text size="sm" role="note">
              {t("project.proposal.others", { count: others.count })}{" "}
              {others.teams.map((team, index) => (
                <Fragment key={team.teamId}>
                  {index > 0 && ", "}
                  <EntityLink entity={{ kind: "team", id: team.teamId }} name={team.name} underline="always" />
                </Fragment>
              ))}
            </Text>
          )}
          <CrossTeamRunView
            run={run}
            check={check}
            selected={flow.selected}
            applying={flow.applying}
            onToggle={flow.toggle}
            onSelectAll={flow.selectAll}
            onSelectNone={flow.selectNone}
            acceptable={rights.acceptable}
            projectId={proposal.projectId}
            projectMilestoneIds={proposal.milestoneIds}
          />
          {error && (
            <FormErrorAlert ref={errorRef} tabIndex={-1}>
              {error}
            </FormErrorAlert>
          )}
          <Group gap="sm">
            {flow.canAccept && (
              <Button leftSection={<IconCheck size={16} />} loading={flow.applying} disabled={flow.selected.size === 0 || busy} onClick={flow.accept}>
                {t("teams.proposal.accept", { count: flow.selected.size })}
              </Button>
            )}
            <Button variant="default" leftSection={<IconRefresh size={16} />} disabled={busy} onClick={() => flow.proposeAgain(proposal.teamIds, flow.selected)}>
              {t("programs.proposal.again")}
            </Button>
            <Button
              variant="default"
              leftSection={<IconX size={16} />}
              disabled={flow.applying}
              onClick={() => {
                if (flow.discard()) announce(t("project.proposal.discarded"));
              }}
            >
              {t("teams.proposal.discard")}
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}
