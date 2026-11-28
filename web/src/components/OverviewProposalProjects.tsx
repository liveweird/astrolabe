import { Stack, Table, Text, Title } from "@mantine/core";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { CrossTeamProposal } from "../api/scheduleProposals";
import EntityLink from "./EntityLink";
import ScrollRegion from "./ScrollRegion";

type ProposedProject = CrossTeamProposal["projects"][number];

const NO_WRAP = { whiteSpace: "nowrap" } as const;
const TABLE_MAX_HEIGHT = 320;

/** "N working days earlier" / "later" (the milestones' own sentences), "End unchanged" when only the start moves, "Newly scheduled" for a project that had no dates. */
function endShiftText(project: ProposedProject, t: TFunction): string {
  const days = project.endShiftDays;
  if (days === null) return t("programs.proposal.newly");
  if (days === 0) return t("programs.proposal.endSame");
  return t(days < 0 ? "teams.proposal.change.earlier" : "teams.proposal.change.later", { count: Math.abs(days) });
}

/**
 * "Projects whose dates would move" (1.33): the run's `projects[]` - the projects whose derived span the accepted run would change, each with its span now and after
 * and how many working days its END moves. The server computed every figure over every milestone of the project (the run teams' proposed dates, the stored dates
 * of any other team), so a project on a team outside the run is judged with its dates kept. The names are links; the table says nothing while the run moves no project.
 * The ROWS and their order are the run's, whatever is ticked (the table sits above the ticks: nothing jumps); `moving` (1.38) are the entries the ticked moves still move, the
 * server's own answer: a row whose project is not among them reads "Unchanged" / "Would not move".
 */
export default function OverviewProposalProjects({ projects, moving }: { projects: readonly ProposedProject[]; moving: readonly ProposedProject[] }) {
  const { t } = useTranslation();
  if (projects.length === 0) {
    return (
      <Text size="sm" c="dimmed" role="note">
        {t("programs.proposal.noProjectMoves")}
      </Text>
    );
  }
  const name = t("programs.proposal.projectsTitle");
  return (
    <Stack gap="xs">
      <Title order={4} size="h5">
        {name}
      </Title>
      <ScrollRegion label={name} minWidth={640} maxHeight={TABLE_MAX_HEIGHT}>
        <Table aria-label={name} stickyHeader>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("programs.proposal.column.project")}</Table.Th>
              <Table.Th>{t("programs.proposal.column.now")}</Table.Th>
              <Table.Th>{t("programs.proposal.column.proposed")}</Table.Th>
              <Table.Th>{t("programs.proposal.column.end")}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {projects.map((row) => {
              const project = moving.find((entry) => entry.projectId === row.projectId);
              return (
                <Table.Tr key={row.projectId}>
                  <Table.Td>
                    <EntityLink entity={{ kind: "project", id: row.projectId }} name={row.name} size="sm" fw={500} />
                  </Table.Td>
                  <Table.Td style={NO_WRAP}>{row.before === null ? t("teams.proposal.unscheduled") : t("teams.proposal.span", row.before)}</Table.Td>
                  <Table.Td style={NO_WRAP}>{project === undefined ? t("programs.proposal.stays") : t("teams.proposal.span", project.after)}</Table.Td>
                  <Table.Td>{project === undefined ? t("programs.proposal.wontMove") : endShiftText(project, t)}</Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </ScrollRegion>
    </Stack>
  );
}
