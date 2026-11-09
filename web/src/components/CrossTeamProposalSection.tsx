import { Group, Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { CrossTeamProposalTeam } from "../api/scheduleProposals";
import type { ScheduleCheckState } from "../utils/scheduleProposal";
import ProposalTable from "./ProposalTable";
import TeamWeeklyLoad from "./TeamWeeklyLoad";

/** One team's block of a cross-team run as the page shows it: the run's block with the verdicts and the load of the TICKED moves (`overlayCheck`). */
export type CrossTeamSectionTeam = Omit<CrossTeamProposalTeam, "weeks"> & { weeks?: CrossTeamProposalTeam["weeks"] };

/**
 * One team's section of the cross-team page (1.8): the team's name as an h3 with its place in the placement order, the table of its moves
 * (`ProposalTable`, the team page's, named for the team) and, collapsed, the team's weekly load after the TICKED moves. Controlled and without
 * actions of its own: the page holds the ONE selection and the ONE accept, "Select all" in the table acts on THIS team's moves. The server decided
 * every date and verdict; `weeks` is absent while none of the run's moves is ticked (there is no load to show for nothing).
 */
export default function CrossTeamProposalSection({
  team,
  asOf,
  position,
  total,
  selected,
  applying,
  check,
  onToggle,
  onSelectAll,
  onSelectNone,
}: {
  team: CrossTeamSectionTeam;
  asOf: string;
  /** 1-based place in the run's placement order. */
  position: number;
  total: number;
  selected: ReadonlySet<number>;
  applying: boolean;
  check: Pick<ScheduleCheckState, "pending" | "failed">;
  onToggle: (milestoneId: number) => void;
  onSelectAll: (teamId: number) => void;
  onSelectNone: (teamId: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap="xs">
      <Group gap="sm" align="baseline">
        <Title order={3} size="h4">
          {team.name}
        </Title>
        <Text size="sm" c="dimmed">
          {t("scheduleProposals.section.placed", { position, total })}
        </Text>
      </Group>
      <ProposalTable
        proposal={{ ...team, asOf }}
        label={t("scheduleProposals.section.tableAria", { name: team.name })}
        selected={selected}
        applying={applying}
        check={check}
        onToggle={onToggle}
        onSelectAll={() => onSelectAll(team.teamId)}
        onSelectNone={() => onSelectNone(team.teamId)}
      />
      {team.weeks === undefined ? (
        <Text size="sm" c="dimmed">
          {t("scheduleProposals.section.loadNone")}
        </Text>
      ) : (
        <TeamWeeklyLoad
          weeks={team.weeks}
          truncated={team.weeksTruncated}
          labels={{
            title: t("scheduleProposals.section.loadTitle"),
            intro: t("scheduleProposals.section.loadIntro"),
            aria: t("scheduleProposals.section.loadAria", { name: team.name }),
            headingOrder: 4,
            showLabel: t("scheduleProposals.section.showLoad", { name: team.name }),
            hideLabel: t("scheduleProposals.section.hideLoad", { name: team.name }),
          }}
        />
      )}
    </Stack>
  );
}
