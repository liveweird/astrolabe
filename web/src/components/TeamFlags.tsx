import { useTranslation } from "react-i18next";
import { Badge, Group } from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";
import type { PlanFlag } from "../api/roadmap";
import { flagSentence } from "../utils/flagSentences";

/** The team-level flags name no project and no team (today only `FLOW_CAPACITY`), so no name is ever asked for. */
const NO_NAMES = { project: () => "", team: () => "" };

/**
 * A team's flags, each as its own sentence in words (never a count: the roll-up is ONE flag whose sentence carries the number of sprints): a
 * light badge, orange with a triangle for a warning, gray with an info circle for an info (the theme owns the AA inks). The sentence is the
 * badge's only text — the icon is decorative — so it is announced once. The team page's header and Home's team rows draw the same badge.
 */
export default function TeamFlags({ flags }: { flags: readonly PlanFlag[] }) {
  const { t } = useTranslation();
  return (
    <Group gap="xs" wrap="wrap">
      {flags.map((flag, index) => {
        const warning = flag.severity === "WARNING";
        const Icon = warning ? IconAlertTriangle : IconInfoCircle;
        return (
          <Badge
            key={`${flag.kind}-${index}`}
            color={warning ? "orange" : "gray"}
            tt="none"
            miw="max-content"
            leftSection={<Icon size={12} aria-hidden="true" />}
            data-team-flag={flag.kind}
            data-severity={flag.severity}
          >
            {flagSentence(t, flag, NO_NAMES, null)}
          </Badge>
        );
      })}
    </Group>
  );
}
