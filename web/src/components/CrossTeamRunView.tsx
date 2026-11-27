import { Stack } from "@mantine/core";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import { overlayCheck, type ScheduleCheckState } from "../utils/scheduleProposal";
import CrossTeamFacts from "./CrossTeamFacts";
import CrossTeamProposalSection from "./CrossTeamProposalSection";

/**
 * A run as the cross-team pages show it (the facts line, then one section per team in placement order with the verdicts and load of the
 * TICKED moves): the open run of `/schedule-proposals` and a saved run's page share it. Controlled: the owner holds the selection;
 * `applying` also locks every checkbox (a saved run the viewer may not accept is read-only).
 */
export default function CrossTeamRunView({
  run,
  check,
  selected,
  applying,
  onToggle,
  onSelectAll,
  onSelectNone,
  live = true,
}: {
  run: CrossTeamProposal;
  check: ScheduleCheckState;
  selected: ReadonlySet<number>;
  applying: boolean;
  onToggle: (milestoneId: number) => void;
  onSelectAll: (teamId: number) => void;
  onSelectNone: (teamId: number) => void;
  /** False for a saved run the plan has moved on from (`CHANGED`): its teams, projects and milestones may be gone, so their names are not links. */
  live?: boolean;
}) {
  return (
    <Stack gap="lg">
      <CrossTeamFacts passes={run.passes} settled={run.settled} />
      {run.teams.map((block, index) => (
        <CrossTeamProposalSection
          key={block.teamId}
          team={overlayCheck(block, check, block.teamId)}
          asOf={run.asOf}
          position={index + 1}
          total={run.teams.length}
          selected={selected}
          applying={applying}
          check={check}
          onToggle={onToggle}
          onSelectAll={onSelectAll}
          onSelectNone={onSelectNone}
          live={live}
        />
      ))}
    </Stack>
  );
}
