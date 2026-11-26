import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Box, Button, Group, Select, Stack, Table, Text, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconTimelineEvent } from "@tabler/icons-react";
import type { ProjectMilestone, ProjectView } from "../api/milestones";
import { FILTER_DEBOUNCE_MS } from "../hooks/usePagedSort";
import { useTeamColours } from "../hooks/useTeamColours";
import { isBoolean, useStoredState } from "../hooks/useStoredState";
import {
  filterMilestones,
  isScheduled,
  MILESTONE_SCHEDULES,
  milestoneTeams,
  narrowingCount,
  parseScheduleParam,
  projectMilestones,
  sortMilestones,
  type MilestoneSchedule,
  type MilestoneSortDir,
  type MilestoneSortField,
} from "../utils/projectMilestones";
import type { TeamColour } from "../utils/teamColours";
import ClearableTextInput from "./ClearableTextInput";
import EmptyState from "./EmptyState";
import ScrollRegion from "./ScrollRegion";
import SortHeader from "./SortHeader";
import TableDisclosure from "./TableDisclosure";
import TeamFilterSelect from "./TeamFilterSelect";
import TeamNameCell from "./TeamNameCell";
import EntityLink from "./EntityLink";

const TABLE_MAX_HEIGHT = 420;
const NO_WRAP = { whiteSpace: "nowrap" } as const;
const CONTROL_WIDTH = { base: "100%", xs: 200 } as const;

/** The view-settings key of the show/hide choice (`astrolabe.viewSettings.project.milestonesOpen`), shared by every project. */
const OPEN_KEY = "project.milestonesOpen";

function MilestoneRow({ milestone, colour }: { milestone: ProjectMilestone; colour: TeamColour | undefined }) {
  const { t } = useTranslation();
  return (
    <Table.Tr>
      <Table.Td>
        <Text size="sm" fw={500}>
          {milestone.name}
        </Text>
      </Table.Td>
      <Table.Td>
        <EntityLink entity={{ kind: "team", id: milestone.teamId }} name={milestone.teamName} size="sm">
          <TeamNameCell name={milestone.teamName} colour={colour} />
        </EntityLink>
      </Table.Td>
      <Table.Td style={NO_WRAP}>
        <Text size="sm">{milestone.estimateMd}</Text>
      </Table.Td>
      {isScheduled(milestone) ? (
        <>
          <Table.Td style={NO_WRAP}>
            <Text size="sm">{milestone.startDate}</Text>
          </Table.Td>
          <Table.Td style={NO_WRAP}>
            <Text size="sm">{milestone.endDate}</Text>
          </Table.Td>
        </>
      ) : (
        // Both dates are null together: one dimmed cell across the two columns.
        <Table.Td colSpan={2}>
          <Text size="sm" c="dimmed">
            {t("project.milestones.notScheduled")}
          </Text>
        </Table.Td>
      )}
    </Table.Tr>
  );
}

/**
 * The project page's Milestones section (1.29): every milestone of the project - the view's own `scheduled` and `unscheduled`, nothing fetched or
 * recomputed - as a filterable, sortable table, the Milestones page's filters narrowed to one project. The Schedule choice (All / Not scheduled /
 * Scheduled) lives in the address (`?milestones=`, which also OPENS the table without writing the remembered choice); the team (the project's own
 * teams) and the name (a folded substring match) are page state. The show/hide choice is remembered per browser (default shown); a hidden table is
 * not rendered, so it does not print either. Read-only: the dates are set on the timeline and the tray above.
 */
export default function ProjectMilestonesTable({ view }: { view: ProjectView }) {
  const { t } = useTranslation();
  const colours = useTeamColours();
  const [params, setParams] = useSearchParams();
  const fromAddress = parseScheduleParam(params.get("milestones"));
  const schedule: MilestoneSchedule = fromAddress ?? "all";
  const [remembered, setRemembered] = useStoredState(OPEN_KEY, true, isBoolean);
  const open = remembered || fromAddress !== undefined;
  const [teamId, setTeamId] = useState<number | undefined>(undefined);
  const [name, setName] = useState("");
  const [sort, setSort] = useState<{ field: MilestoneSortField; dir: MilestoneSortDir }>({ field: "start", dir: "asc" });

  const all = projectMilestones(view);
  const teams = milestoneTeams(all);
  // A team the project no longer has (its last milestone moved or went) is no filter: the table never stays empty behind a select that cannot show why.
  const team = teams.some((candidate) => candidate.id === teamId) ? teamId : undefined;
  const narrowing = { schedule, teamId: team, name };
  const narrowed = narrowingCount(narrowing) > 0;
  const rows = sortMilestones(filterMilestones(all, narrowing), sort.field, sort.dir);
  // Only the ANNOUNCED count waits for typing to pause (the rows follow every keystroke); an emptied name is announced at once.
  const [settledName] = useDebouncedValue(name.trim(), FILTER_DEBOUNCE_MS);
  const announcedNarrowing = { ...narrowing, name: name.trim() === "" ? "" : settledName };
  const announcedNarrowed = narrowingCount(announcedNarrowing) > 0;
  const announcedShown = announcedNarrowed ? filterMilestones(all, announcedNarrowing).length : all.length;

  const writeSchedule = (choice: MilestoneSchedule) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("milestones", choice);
        return next;
      },
      { replace: true },
    );
  const toggle = (next: boolean) => {
    setRemembered(next);
    // The address opened it: hiding takes the parameter away, or the table would stay open (and a reload would open it again).
    if (!next && fromAddress !== undefined) {
      setParams(
        (previous) => {
          const stripped = new URLSearchParams(previous);
          stripped.delete("milestones");
          return stripped;
        },
        { replace: true },
      );
    }
  };
  const clear = () => {
    // The address is left alone unless it holds the parameter (then "all" keeps the table open, as the other choices do).
    if (fromAddress !== undefined) writeSchedule("all");
    setTeamId(undefined);
    setName("");
  };
  const toggleSort = (field: MilestoneSortField) => setSort((current) => ({ field, dir: current.field === field && current.dir === "asc" ? "desc" : "asc" }));
  const label = t("project.milestones.tableAria");

  return (
    <Stack gap="xs">
      <Title order={3} size="h4">
        {t("project.milestones.title")}
      </Title>
      <TableDisclosure open={open} onOpenChange={toggle} showLabel={t("project.milestones.show")} hideLabel={t("project.milestones.hide")}>
        <Stack gap="xs">
          <Group gap="sm" align="flex-end" data-print="hide">
            <Box w={CONTROL_WIDTH}>
              <Select
                label={t("project.milestones.filter.schedule")}
                data={MILESTONE_SCHEDULES.map((choice) => ({ value: choice, label: t(`project.milestones.schedule.${choice}`) }))}
                value={schedule}
                onChange={(selected) => selected !== null && writeSchedule(selected as MilestoneSchedule)}
                allowDeselect={false}
              />
            </Box>
            <Box w={CONTROL_WIDTH}>
              <TeamFilterSelect teamId={team} onChange={setTeamId} teams={teams} settled={false} />
            </Box>
            <Box w={CONTROL_WIDTH}>
              <ClearableTextInput label={t("common.field.name")} value={name} onChange={setName} clearLabel={t("common.filter.clearName")} />
            </Box>
            {narrowed && (
              <Button variant="default" size="compact-md" onClick={clear}>
                {t("project.milestones.clear")}
              </Button>
            )}
          </Group>
          <Text size="sm" c="dimmed" role="status">
            {announcedNarrowed ? t("project.milestones.shownOf", { shown: announcedShown, count: all.length }) : t("project.milestones.count", { count: all.length })}
          </Text>
          <ScrollRegion label={label} minWidth={640} maxHeight={TABLE_MAX_HEIGHT}>
            <Table aria-label={label} stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <SortHeader field="name" label={t("project.column.milestone")} activeField={sort.field} activeDir={sort.dir} onToggle={toggleSort} />
                  <SortHeader field="team" label={t("project.column.team")} activeField={sort.field} activeDir={sort.dir} onToggle={toggleSort} />
                  <Table.Th>{t("project.milestones.column.estimate")}</Table.Th>
                  <SortHeader field="start" label={t("project.milestones.column.start")} activeField={sort.field} activeDir={sort.dir} onToggle={toggleSort} />
                  <Table.Th>{t("project.milestones.column.end")}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={5}>
                      <EmptyState icon={IconTimelineEvent} label={t("project.milestones.noMatch")} />
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  rows.map((milestone) => <MilestoneRow key={milestone.id} milestone={milestone} colour={colours.get(milestone.teamId)} />)
                )}
              </Table.Tbody>
            </Table>
          </ScrollRegion>
        </Stack>
      </TableDisclosure>
    </Stack>
  );
}
