import { Badge, Group } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { components } from "../api/schema";

/** A row's roll-up of the Roadmap's flags in the facts line's own words: an orange warnings badge and a gray infos badge, each only when positive. */
export default function HomeFlagBadges({ flags }: { flags: components["schemas"]["FlagCounts"] }) {
  const { t } = useTranslation();
  if (flags.warnings + flags.infos === 0) return null;
  return (
    <Group gap="xs" wrap="wrap">
      {flags.warnings > 0 && (
        <Badge color="orange" tt="none">
          {t("roadmap.facts.warnings", { count: flags.warnings })}
        </Badge>
      )}
      {flags.infos > 0 && (
        <Badge color="gray" tt="none">
          {t("roadmap.facts.infos", { count: flags.infos })}
        </Badge>
      )}
    </Group>
  );
}
