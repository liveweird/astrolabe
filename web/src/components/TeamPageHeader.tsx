import { useTranslation } from "react-i18next";
import { Button, Text } from "@mantine/core";
import { IconPencil } from "@tabler/icons-react";
import type { TeamView } from "../api/teams";
import { teamsPath } from "../utils/teamLinks";
import PageHeader from "./PageHeader";

/** The team page's header: the name, the description and manager lines, and an ADMIN's Edit. */
export default function TeamPageHeader({ team, admin, onEdit }: { team: TeamView["team"]; admin: boolean; onEdit: () => void }) {
  const { t } = useTranslation();
  return (
    <PageHeader
      title={team.name}
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
