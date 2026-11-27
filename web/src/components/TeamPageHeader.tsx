import { useTranslation } from "react-i18next";
import { Button, Text } from "@mantine/core";
import { IconPencil } from "@tabler/icons-react";
import type { TeamView } from "../api/teams";
import { teamsPath } from "../utils/teamLinks";
import { refOf } from "../utils/entityLinks";
import EntityLink from "./EntityLink";
import EntitySentence from "./EntitySentence";
import PageHeader from "./PageHeader";
import TeamFlags from "./TeamFlags";
import TeamSwatch from "./TeamSwatch";

/**
 * The team page's header: the name, behind its colour swatch (1.29), with the view's team-level flags beside it (1.9: the ONE Flow flag, the `FLOW_CAPACITY` roll-up or, since 1.26.0, the neutral `FLOW_CAPACITY_PENDING`, as an icon + sentence badge; nothing for `[]`), the description and manager lines, and an ADMIN's Edit.
 */
export default function TeamPageHeader({ team, admin, onEdit }: { team: TeamView["team"]; admin: boolean; onEdit: () => void }) {
  const { t } = useTranslation();
  return (
    <PageHeader
      title={team.name}
      titleLead={<TeamSwatch colour={team.colour} size={16} />}
      titleAddon={team.flags.length > 0 ? <TeamFlags flags={team.flags} /> : undefined}
      description={
        <>
          {team.description && (
            <Text span display="block">
              {team.description}
            </Text>
          )}
          <Text span display="block">
            {team.managerName === null ? (
              t("teams.noManager")
            ) : (
              <EntitySentence
                text={(marks) => t("teams.managerLine", { name: marks.manager })}
                slots={{ manager: <EntityLink entity={refOf("person", team.managerPersonId)} name={team.managerName} /> }}
              />
            )}
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
