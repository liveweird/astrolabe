import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Group, MultiSelect, Stack, VisuallyHidden } from "@mantine/core";
import { IconCalendarStats, IconCheck, IconWand, IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { listProposalTeams } from "../api/scheduleProposals";
import { useAdmin } from "../auth";
import CrossTeamFacts from "../components/CrossTeamFacts";
import CrossTeamProposalSection from "../components/CrossTeamProposalSection";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import FormErrorAlert from "../components/FormErrorAlert";
import LoadingBlock from "../components/LoadingBlock";
import PageHeader from "../components/PageHeader";
import ProposalNotes from "../components/TeamProposalNotes";
import { movesOf, useCrossTeamProposal } from "../hooks/useCrossTeamProposal";
import { useProposalFocus } from "../hooks/useProposalFocus";
import { useScheduleCheck } from "../hooks/useScheduleCheck";
import { overlayCheck } from "../utils/scheduleProposal";

/** Zero-width space: toggled on the live-region text so the same sentence twice is announced twice. */
const REREAD = "​";

/** The run takes `teamIds[1..50]`: the multi-select's `maxValues` and the "All teams" shortcut (the first 50 listed) share it. */
const MAX_TEAMS = 50;

/**
 * Schedule proposals (`/schedule-proposals`, 1.8): ONE proposal over several teams. The multi-select offers the teams the SERVER says the caller
 * may include (`GET /schedule-proposals/teams`: an administrator's are all, a manager's their own; the server's 403 on the run stays the rule).
 * Propose places the teams in dependency order, each with the teams placed before it as fixed dates, until the dates stop changing; the page
 * reads that run, never recomputes it: a section per team in placement order (its table and, collapsed, its load), the facts line (passes,
 * settled or not), and ONE accept for the ticked moves of every section - one plan write. While only some moves are ticked the server checks
 * exactly those (`useScheduleCheck`) and every section follows. A change of the plan under the run re-proposes at once with the ticks kept
 * (`useCrossTeamProposal`). Nothing changes until the accept; failures stay inline and the one polite status region says each step.
 */
export default function ScheduleProposals() {
  const { t } = useTranslation();
  // The words of the empty state and the "All teams" shortcut depend on it (an administrator with no team has none to propose for); the server's list decides what is offered.
  const admin = useAdmin();
  const teams = useQuery({ queryKey: ["schedule-proposals", "teams"], queryFn: listProposalTeams });
  const [announcement, setAnnouncement] = useState("");
  const flow = useCrossTeamProposal((text) => setAnnouncement((previous) => (previous.endsWith(REREAD) ? text : text + REREAD)));
  const run = flow.proposal;
  const [picked, setPicked] = useState<string[]>([]);
  const busy = flow.requesting || flow.applying;
  const { proposeRef, discardRef } = useProposalFocus(flow, run, busy);
  const check = useScheduleCheck({
    teamIds: run?.teams.map((team) => team.teamId) ?? [],
    revision: run?.revision ?? 0,
    scopeHash: run?.scopeHash ?? "",
    moves: movesOf(run),
    selected: flow.selected,
    enabled: run !== null,
  });
  // The accept button was the focus and is disabled while the write runs, so a failure would leave the focus on the body: it goes to the alert.
  const errorRef = useRef<HTMLDivElement>(null);
  const { error } = flow;
  useEffect(() => {
    if (error && run !== null) errorRef.current?.focus();
  }, [error, run]);

  const items = teams.data?.items ?? [];
  const listed = new Set(items.map((team) => String(team.id)));
  const chosen = picked.filter((id) => listed.has(id)).map(Number);
  const open = run !== null || flow.requesting;

  return (
    <Stack gap="md">
      <PageHeader
        title={t("scheduleProposals.title")}
        description={t("scheduleProposals.intro")}
        actions={
          items.length > 0 && (
            <Button ref={proposeRef} leftSection={<IconWand size={16} />} loading={flow.requesting} disabled={chosen.length === 0 || open || busy} onClick={() => flow.propose(chosen)}>
              {t("scheduleProposals.propose")}
            </Button>
          )
        }
      />
      {teams.isError && <ErrorAlert error={teams.error} title={t("scheduleProposals.loadFailed")} />}
      {teams.isLoading && <LoadingBlock />}
      {teams.isSuccess && items.length === 0 && <EmptyState icon={IconCalendarStats} label={t(admin ? "scheduleProposals.noTeamsAdmin" : "scheduleProposals.noTeams")} hint={t(admin ? "scheduleProposals.noTeamsAdminHint" : "scheduleProposals.noTeamsHint")} />}
      {items.length > 0 && (
        <Group gap="sm" align="flex-end" wrap="wrap">
          <MultiSelect
            label={t("scheduleProposals.teams")}
            description={run !== null ? t("scheduleProposals.readOnly") : flow.requesting ? t("scheduleProposals.requesting") : undefined}
            placeholder={chosen.length === 0 ? t("scheduleProposals.teamsPlaceholder") : undefined}
            data={items.map((team) => ({ value: String(team.id), label: team.name }))}
            value={chosen.map(String)}
            onChange={setPicked}
            maxValues={MAX_TEAMS}
            disabled={open}
            searchable
            clearable
            clearButtonProps={{ "aria-label": t("scheduleProposals.clearTeams") }}
            maw={640}
            style={{ flex: "1 1 20rem" }}
          />
          {admin && (
            <Button variant="default" disabled={open} onClick={() => setPicked(items.slice(0, MAX_TEAMS).map((team) => String(team.id)))}>
              {t("scheduleProposals.allTeams")}
            </Button>
          )}
        </Group>
      )}
      {flow.refused && (
        <Alert color="orange" variant="light" role="note">
          {t("project.busy")}
        </Alert>
      )}
      <ProposalNotes proposal={flow} />
      {run !== null && (
        <Stack gap="lg">
          <CrossTeamFacts passes={run.passes} settled={run.settled} />
          {run.teams.map((block, index) => (
            <CrossTeamProposalSection
              key={block.teamId}
              team={overlayCheck(block, check, block.teamId)}
              asOf={run.asOf}
              position={index + 1}
              total={run.teams.length}
              selected={flow.selected}
              applying={flow.applying}
              check={check}
              onToggle={flow.toggle}
              onSelectAll={flow.selectAll}
              onSelectNone={flow.selectNone}
            />
          ))}
          {error && (
            <FormErrorAlert ref={errorRef} tabIndex={-1}>
              {error}
            </FormErrorAlert>
          )}
          <Group gap="sm">
            <Button leftSection={<IconCheck size={16} />} loading={flow.applying} disabled={flow.selected.size === 0 || busy} onClick={flow.accept}>
              {t("scheduleProposals.accept", { count: flow.selected.size })}
            </Button>
            <Button ref={discardRef} variant="default" leftSection={<IconX size={16} />} disabled={flow.applying} onClick={flow.discard}>
              {t("teams.proposal.discard")}
            </Button>
          </Group>
        </Stack>
      )}
      {/* The page's one polite status region: every taken step is said here (the notes above are visible only). */}
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>
    </Stack>
  );
}
