import { Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { CrossTeamProposal, CrossTeamProposalTeam } from "../api/scheduleProposals";
import { projectSlice, tickableMoveIds } from "../utils/planProposal";
import { isMoveEnd, overlayCheck, type ScheduleCheckState } from "../utils/scheduleProposal";
import CrossTeamFacts from "./CrossTeamFacts";
import CrossTeamProposalSection from "./CrossTeamProposalSection";

const IDLE_CHECK = { pending: false, failed: false } as const;

/** A slice keeps the links that touch one of its kept moves (the verdicts of the team's other milestones are not this project's to show). */
const linksOfMoves = <T extends { moves: CrossTeamProposalTeam["moves"]; dependencies: CrossTeamProposalTeam["dependencies"] }>(team: T): T => ({
  ...team,
  dependencies: team.dependencies.filter((link) => team.moves.some((move) => isMoveEnd(link.predecessor, move) || isMoveEnd(link.successor, move))),
});

/**
 * A run as the cross-team pages show it (the facts line, then one section per team in placement order with the verdicts and load of the
 * TICKED moves): the Roadmap overview's open run and a saved run on it share it. Controlled: the owner holds the selection;
 * `applying` also locks every checkbox (a saved run the viewer may not accept is read-only).
 *
 * `acceptable` (1.33, the ids of the teams whose moves the viewer may accept) makes it a preview for everyone: the sections of other teams are
 * collapsed, read-only and show the run as it would be "if that team's manager accepts" (the check's verdicts and load, which describe the
 * viewer's ticks, overlay only the sections of acceptable teams); a viewer who may accept none of the shown teams reads one sentence above them
 * instead of one per section (and none at all when the slice has no section). `projectId` narrows the sections to one project's moves (`projectSlice`;
 * `projectMilestoneIds` keeps its `unchanged` and `pinned` figures) and the links to those touching a kept move.
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
  acceptable,
  projectId,
  projectMilestoneIds,
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
  acceptable?: ReadonlySet<number>;
  projectId?: number;
  projectMilestoneIds?: ReadonlySet<number>;
}) {
  const { t } = useTranslation();
  const sections = projectSlice(run, projectId, projectMilestoneIds);
  const yours = (teamId: number) => acceptable === undefined || acceptable.has(teamId);
  // Nothing to tick in what is shown: the viewer manages none of the teams, or the shown part of the run holds no move of theirs.
  const none = acceptable !== undefined && sections.length > 0 && tickableMoveIds(run, acceptable, projectId).size === 0;
  const shaped = (team: CrossTeamProposalTeam, own: boolean) => {
    const overlaid = own ? overlayCheck(team, check, team.teamId) : team;
    return projectId === undefined ? overlaid : linksOfMoves(overlaid);
  };
  return (
    <Stack gap="lg">
      <CrossTeamFacts passes={run.passes} settled={run.settled} />
      {none && (
        <Text size="sm" role="note">
          {t("scheduleProposals.section.previewOnly")}
        </Text>
      )}
      {sections.map(({ team, position }) => {
        const own = yours(team.teamId);
        return (
          <CrossTeamProposalSection
            key={team.teamId}
            team={shaped(team, own)}
            asOf={run.asOf}
            position={position}
            total={run.teams.length}
            selected={selected}
            applying={applying}
            check={own ? check : IDLE_CHECK}
            onToggle={onToggle}
            onSelectAll={onSelectAll}
            onSelectNone={onSelectNone}
            live={live}
            acceptable={acceptable === undefined ? undefined : own}
            readOnlyNote={!none}
          />
        );
      })}
    </Stack>
  );
}
