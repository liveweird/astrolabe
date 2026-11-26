import { Group, Text } from "@mantine/core";
import type { TeamColour } from "../utils/teamColours";
import TeamSwatch from "./TeamSwatch";

/**
 * A Team cell of a timeline row (1.29): the team's colour swatch and its name, which is the key to the milestone bar's colour in the same row (the
 * name stays beside the mark, so colour is never the only cue). `dimmed` is another project's row. An unknown colour keeps the swatch's box, hidden.
 */
export default function TeamNameCell({ name, colour, dimmed = false }: { name: string; colour: TeamColour | undefined; dimmed?: boolean }) {
  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      <TeamSwatch colour={colour} />
      <Text component="span" size="sm" c={dimmed ? "dimmed" : undefined} truncate>
        {name}
      </Text>
    </Group>
  );
}
