import { useTranslation } from "react-i18next";
import { Badge, Button, Group, Text } from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle, IconPencil } from "@tabler/icons-react";
import type { TeamView } from "../api/teams";
import { teamsPath } from "../utils/teamLinks";
import { flagSentence } from "../utils/flagSentences";
import PageHeader from "./PageHeader";

/** The team-level flags name no project and no team (today only `FLOW_CAPACITY`), so no name is ever asked for. */
const NO_NAMES = { project: () => "", team: () => "" };

/**
 * The header's flags, each as its own sentence in words (never a count: the roll-up is ONE flag whose sentence carries the number of sprints): a
 * light badge, orange with a triangle for a warning, gray with an info circle for an info (the theme owns the AA inks). The sentence is the
 * badge's only text — the icon is decorative — so it is announced once.
 */
function TeamFlags({ flags }: { flags: TeamView["team"]["flags"] }) {
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
            variant="light"
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

/**
 * The team page's header: the name with the view's team-level flags beside it (1.9: the ONE `FLOW_CAPACITY` roll-up as an icon + sentence badge; nothing for `[]`), the description and manager lines, and an ADMIN's Edit.
 */
export default function TeamPageHeader({ team, admin, onEdit }: { team: TeamView["team"]; admin: boolean; onEdit: () => void }) {
  const { t } = useTranslation();
  return (
    <PageHeader
      title={team.name}
      titleAddon={team.flags.length > 0 ? <TeamFlags flags={team.flags} /> : undefined}
      description={
        <>
          {team.description && (
            <Text span display="block">
              {team.description}
            </Text>
          )}
          <Text span display="block">
            {team.managerName ? t("teams.managerLine", { name: team.managerName }) : t("teams.noManager")}
          </Text>
        </>
      }
      backTo={{ to: teamsPath, label: t("teams.backToTeams") }}
      actions={
        admin && (
          <Button variant="default" leftSection={<IconPencil size={16} />} onClick={onEdit}>
            {t("common.action.edit")}
          </Button>
        )
      }
    />
  );
}
