import { Anchor, Table } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import type { HomeMe } from "../api/home";
import { roadmapFilteredPath } from "../utils/planLinks";
import EntityLink from "./EntityLink";
import HomeFlagBadges from "./HomeFlagBadges";
import ScrollRegion from "./ScrollRegion";

/**
 * "Your programs and work streams": the work streams the person owns and the programs they may manage (owned, or under a work stream they own), work
 * streams first, each row naming its owner: a work stream's is the person (`personName`, a work stream is listed only when they own it), a program's its
 * own `ownerName`. Neither has a page of its own: the name is the link to the Roadmap overview narrowed to it (1.31), and the projects figure, while positive,
 * is the link to the Prioritization Roadmap filtered to it (the Work stream filter, the program pick with one program); the flags are the Programs page's roll-up
 * over the projects below.
 */
export default function HomeNodesTable({
  workStreams,
  programs,
  personId,
  personName,
}: {
  workStreams: HomeMe["workStreams"];
  programs: HomeMe["programs"];
  personId: number;
  personName: string;
}) {
  const { t } = useTranslation();
  // The projects figure leads to the Roadmap filtered to the node (a node with no project is no filter option there: its zero is plain text).
  const projectsFigure = (count: number, to: string, name: string) =>
    count > 0 ? (
      <Anchor component={RouterLink} to={to} size="sm" aria-label={t("home.mine.nodeProjectsAria", { count, name })}>
        {count}
      </Anchor>
    ) : (
      count
    );
  // A closed work stream's visible name carries "(closed)", inside its link.
  const streamName = (stream: HomeMe["workStreams"][number]) => (stream.endDate === null ? stream.name : t("plan.move.closedName", { name: stream.name }));
  const label = t("home.mine.nodes");
  return (
    <ScrollRegion label={label} minWidth={820}>
      <Table aria-label={label}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t("home.mine.column.name")}</Table.Th>
            <Table.Th>{t("home.mine.column.level")}</Table.Th>
            <Table.Th>{t("home.mine.column.in")}</Table.Th>
            <Table.Th>{t("home.mine.column.owner")}</Table.Th>
            <Table.Th ta="right">{t("home.mine.column.programs")}</Table.Th>
            <Table.Th ta="right">{t("home.mine.column.projects")}</Table.Th>
            <Table.Th>{t("roadmap.column.flags")}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {workStreams.map((stream) => (
            <Table.Tr key={`stream-${stream.id}`}>
              <Table.Td>
                <EntityLink entity={{ kind: "workStream", id: stream.id }} name={streamName(stream)} size="sm" fw={500} />
              </Table.Td>
              <Table.Td>{t("home.mine.level.workStream")}</Table.Td>
              <Table.Td />
              <Table.Td>
                <EntityLink entity={{ kind: "person", id: personId }} name={personName} size="sm" />
              </Table.Td>
              <Table.Td ta="right">{stream.programs}</Table.Td>
              <Table.Td ta="right">{projectsFigure(stream.projects, roadmapFilteredPath({ filters: { workStreamId: stream.id } }), streamName(stream))}</Table.Td>
              <Table.Td>
                <HomeFlagBadges flags={stream.flags} />
              </Table.Td>
            </Table.Tr>
          ))}
          {programs.map((program) => (
            <Table.Tr key={`program-${program.id}`}>
              <Table.Td>
                <EntityLink entity={{ kind: "program", id: program.id }} name={program.name} size="sm" fw={500} />
              </Table.Td>
              <Table.Td>{t("home.mine.level.program")}</Table.Td>
              <Table.Td>
                <EntityLink entity={{ kind: "workStream", id: program.workStreamId }} name={program.workStreamName} size="sm" />
              </Table.Td>
              <Table.Td>
                <EntityLink entity={{ kind: "person", id: program.ownerPersonId }} name={program.ownerName} size="sm" />
              </Table.Td>
              <Table.Td />
              <Table.Td ta="right">{projectsFigure(program.projects, roadmapFilteredPath({ pick: [program.id] }), program.name)}</Table.Td>
              <Table.Td>
                <HomeFlagBadges flags={program.flags} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}
