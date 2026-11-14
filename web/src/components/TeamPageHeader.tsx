import { useTranslation } from "react-i18next";
import { Button, Text } from "@mantine/core";
import { IconPencil } from "@tabler/icons-react";
import type { TeamView } from "../api/teams";
import { teamsPath } from "../utils/teamLinks";
import PageHeader from "./PageHeader";
import TeamFlags from "./TeamFlags";

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
