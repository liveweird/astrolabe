import { useId, useState } from "react";
import { Badge, Group, Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { CrossTeamProposalTeam } from "../api/scheduleProposals";
import { warningWeekCount } from "../utils/planProposal";
import type { ScheduleCheckState } from "../utils/scheduleProposal";
import EntityLink from "./EntityLink";
import ProposalTable from "./ProposalTable";
import TableDisclosure from "./TableDisclosure";
import TeamWeeklyLoad from "./TeamWeeklyLoad";

/** One team's block of a cross-team run as the page shows it: the run's block with the verdicts and the load of the TICKED moves (`overlayCheck`). */
export type CrossTeamSectionTeam = Omit<CrossTeamProposalTeam, "weeks"> & { weeks?: CrossTeamProposalTeam["weeks"] };

/**
 * One team's section of the cross-team page (1.8): the team's name as an h3 with its place in the placement order, the table of its moves
 * (`ProposalTable`, the team page's, named for the team) and, collapsed, the team's weekly load after the TICKED moves. Controlled and without
 * actions of its own: the page holds the ONE selection and the ONE accept, "Select all" in the table acts on THIS team's moves. The server decided
 * every date and verdict; `weeks` is absent while none of the run's moves is ticked (there is no load to show for nothing).
 *
 * `acceptable` (1.33) says whether the viewer may accept THIS team's moves; absent = the section as the pages for managers have always had it. Given,
 * the section is collapsible (open where the viewer may accept; a closed one renders no table), its header carries the count of weeks with a
 * warning (an orange badge, over the weeks shown), and a team the viewer may not accept shows the run "if this team's manager accepts" with its
 * checkboxes disabled and, unless `readOnlyNote` is false, one sentence saying so (the table's group is described by it). The badge counts the weeks
 * SHOWN: for a team the viewer may not accept those are the team's whole weeks after the run, not only the moves in view (a project slice).
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
  live = true,
  acceptable,
  readOnlyNote = true,
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
  /** False for a stored run whose plan has moved (a team, project or milestone may be gone since): their names are then plain text, not links. */
  live?: boolean;
  acceptable?: boolean;
  /** False when the run says once, above its sections, that the viewer may accept none of them. */
  readOnlyNote?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(acceptable !== false);
  const warnings = acceptable === undefined ? 0 : warningWeekCount(team.weeks);
  const noteId = useId();
  const noted = acceptable === false && readOnlyNote;
  const body = (
    <Stack gap="xs">
      {noted && (
        <Text id={noteId} size="sm" c="dimmed" role="note">
          {t("scheduleProposals.section.notYours")}
        </Text>
      )}
      <Stack gap="xs" role={noted ? "group" : undefined} aria-label={noted ? team.name : undefined} aria-describedby={noted ? noteId : undefined}>
        <ProposalTable
          proposal={{ ...team, asOf }}
          label={t("scheduleProposals.section.tableAria", { name: team.name })}
          selected={selected}
          applying={applying || acceptable === false}
          live={live}
          check={check}
          onToggle={onToggle}
          onSelectAll={() => onSelectAll(team.teamId)}
          onSelectNone={() => onSelectNone(team.teamId)}
        />
      </Stack>
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
  return (
    <Stack gap="xs">
      <Group gap="sm" align="baseline">
        <Title order={3} size="h4">
          {/* In a heading the link keeps the heading's own accessible name (the team's name), so the outline and "Platform" headings stay what they were. */}
          <EntityLink entity={{ kind: "team", id: team.teamId }} name={team.name} aria-label={team.name} current={!live} inherit />
        </Title>
        <Text size="sm" c="dimmed">
          {t("scheduleProposals.section.placed", { position, total })}
        </Text>
        {warnings > 0 && (
          <Badge color="orange" tt="none" miw="max-content">
            {t("scheduleProposals.section.warningWeeks", { count: warnings })}
          </Badge>
        )}
      </Group>
      {acceptable !== undefined && (
        <TableDisclosure
          open={open}
          onOpenChange={setOpen}
          showLabel={t("scheduleProposals.section.show", { name: team.name })}
          hideLabel={t("scheduleProposals.section.hide", { name: team.name })}
        >
          {body}
        </TableDisclosure>
      )}
      {acceptable === undefined && body}
    </Stack>
  );
}
