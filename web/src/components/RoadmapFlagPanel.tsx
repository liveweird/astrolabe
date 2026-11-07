import { Anchor, Badge, Button, Stack, Table, Text, Title } from "@mantine/core";
import { IconTarget } from "@tabler/icons-react";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { PlanFlag } from "../api/roadmap";
import { projectPath } from "../utils/planLinks";
import type { FlagEntry } from "../utils/roadmapRows";
import ScrollRegion from "./ScrollRegion";
import TableDisclosure from "./TableDisclosure";

const TABLE_MAX_HEIGHT = 420;

/** The names a flag's sentence can mention: the other project of a rank inversion, the shared team. */
export type FlagNames = { project: (id: number) => string; team: (id: number) => string };

/** A flag in words, by kind (never colour alone); the day counts are calendar days, the sentences name the project and team they compare. */
function flagSentence(t: TFunction, flag: PlanFlag, names: FlagNames): string {
  const count = flag.days ?? 0;
  switch (flag.kind) {
    case "DRIFT_END_LATE":
      return t("roadmap.flag.endLate", { count });
    case "DRIFT_START_LATE":
      return t("roadmap.flag.startLate", { count });
    case "DRIFT_END_EARLY":
      return t("roadmap.flag.endEarly", { count });
    case "RANK_INVERSION": {
      const other = flag.otherProjectId === null ? "" : names.project(flag.otherProjectId);
      return flag.teamId === null ? t("roadmap.flag.inversionNoTeam", { count, other }) : t("roadmap.flag.inversion", { count, other, team: names.team(flag.teamId) });
    }
    // The Jira kinds (1.3): the server sends them already; the per-deviation wording and the issue key come with the Jira markers (C8).
    case "JIRA_DEVIATION":
      return t("roadmap.flag.jiraDeviation");
    case "JIRA_MILESTONES":
      return t("roadmap.flag.jiraMilestones", { count: flag.count ?? 0 });
  }
}

/**
 * The Flags section: the ACCESSIBLE surface of the row icons. One table row per flag of the visible projects (warnings first, then by rank) with its
 * severity in words, the project as a link, the sentence and "Show in timeline", which moves the keyboard focus to the project's row. Behind a
 * disclosure (a plan can raise a couple of hundred flags); the heading and the count stay visible.
 */
export default function RoadmapFlagPanel({ entries, names, onShow }: { entries: readonly FlagEntry[]; names: FlagNames; onShow: (projectId: number) => void }) {
  const { t } = useTranslation();
  return (
    <Stack gap="xs">
      <Title order={3} size="h4">
        {t("roadmap.flags.title")}
      </Title>
      <Text size="sm" c="dimmed">
        {t("roadmap.flags.intro")}
      </Text>
      {entries.length === 0 ? (
        <Text c="dimmed">{t("roadmap.flags.none")}</Text>
      ) : (
        <TableDisclosure showLabel={t("roadmap.flags.show", { count: entries.length })} hideLabel={t("roadmap.flags.hide")}>
          <ScrollRegion label={t("roadmap.flags.tableAria")} minWidth={640} maxHeight={TABLE_MAX_HEIGHT}>
            <Table aria-label={t("roadmap.flags.tableAria")} stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t("roadmap.flags.severity")}</Table.Th>
                  <Table.Th>{t("roadmap.column.project")}</Table.Th>
                  <Table.Th>{t("roadmap.flags.flag")}</Table.Th>
                  <Table.Th>{t("common.table.operations")}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {entries.map(({ project, flag }, index) => (
                  // A project can carry the same kind twice (two teams, two other projects): the position in the sorted list is the stable key.
                  <Table.Tr key={`${project.id}:${index}`}>
                    <Table.Td>
                      <Badge color={flag.severity === "WARNING" ? "orange" : "gray"} variant="light" tt="none">
                        {t(`roadmap.flags.${flag.severity}`)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Anchor component={RouterLink} to={projectPath(project.id)} size="sm" aria-label={t("roadmap.openProjectAria", { name: project.name })}>
                        {project.name}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{flagSentence(t, flag, names)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Button
                        variant="subtle"
                        size="compact-sm"
                        leftSection={<IconTarget size={14} />}
                        aria-label={t("roadmap.flag.showAria", { name: project.name })}
                        onClick={() => onShow(project.id)}
                      >
                        {t("roadmap.flag.show")}
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollRegion>
        </TableDisclosure>
      )}
    </Stack>
  );
}
