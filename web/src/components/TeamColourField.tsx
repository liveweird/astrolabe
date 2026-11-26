import { Box, Group, Radio, SimpleGrid, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { TeamOption } from "../hooks/useTeamOptions";
import { TEAM_COLOUR_KEYS, type TeamColour } from "../utils/teamColours";
import TeamSwatch from "./TeamSwatch";

/**
 * The team editor's colour: a radio group of the twelve palette keys, each a swatch with its visible name (colour is never the only cue), and, under
 * it, a dimmed "Also used by: A, B" line while another team holds the picked colour. Sharing is allowed, so the line only informs; it sits in a
 * polite live region so a change of pick is heard. `selfId` leaves the edited team out of its own hint.
 */
export default function TeamColourField({
  value,
  onChange,
  teams,
  selfId,
}: {
  value: TeamColour | null;
  onChange: (colour: TeamColour) => void;
  teams: readonly TeamOption[];
  selfId: number | null;
}) {
  const { t } = useTranslation();
  const sharedWith = value === null ? [] : teams.filter((team) => team.colour === value && team.id !== selfId).map((team) => team.name);
  return (
    <Box>
      <Radio.Group
        label={t("teams.colour.label")}
        description={t("teams.colour.hint")}
        value={value ?? ""}
        onChange={(picked) => {
          const colour = TEAM_COLOUR_KEYS.find((key) => key === picked);
          if (colour !== undefined) onChange(colour);
        }}
      >
        <SimpleGrid cols={{ base: 2, xs: 3 }} spacing="xs" verticalSpacing="xs" mt="xs">
          {TEAM_COLOUR_KEYS.map((colour) => (
            <Radio
              key={colour}
              value={colour}
              label={
                <Group component="span" gap={8} wrap="nowrap">
                  <TeamSwatch colour={colour} size={14} />
                  <span>{t(`teams.colour.name.${colour}`)}</span>
                </Group>
              }
            />
          ))}
        </SimpleGrid>
      </Radio.Group>
      <div aria-live="polite">
        {sharedWith.length > 0 && (
          <Text size="xs" c="dimmed" mt="xs">
            {t("teams.colour.sharedWith", { names: sharedWith.join(", ") })}
          </Text>
        )}
      </div>
    </Box>
  );
}
