import { Group } from "@mantine/core";
import type { RovingTarget } from "../utils/timelineModel";
import type { TeamColour } from "../utils/teamColours";
import EntityLink from "./EntityLink";
import TeamSwatch from "./TeamSwatch";

/**
 * A Team cell of a timeline row (1.29): the team's colour swatch and its name, which is the key to the milestone bar's colour in the same row (the
 * name stays beside the mark, so colour is never the only cue). `dimmed` is another project's row. An unknown colour keeps the swatch's box, hidden.
 * `teamId` (1.31) makes the name the link to the team's page (without it the name is plain text); in a grid cell the link is the cell's roving `stop`.
 */
export default function TeamNameCell({ name, colour, dimmed = false, teamId, stop }: { name: string; colour: TeamColour | undefined; dimmed?: boolean; teamId?: number; stop?: RovingTarget }) {
  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      <TeamSwatch colour={colour} />
      <EntityLink entity={teamId === undefined ? null : { kind: "team", id: teamId }} name={name} size="sm" c={dimmed ? "dimmed" : undefined} truncate stop={stop} />
    </Group>
  );
}
