import { Table } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { HomeMe } from "../api/home";
import type { EntityRef } from "../utils/entityLinks";
import { roadmapFilteredPath } from "../utils/planLinks";
import EntityLink from "./EntityLink";
import HomeFlagBadges from "./HomeFlagBadges";
import ScrollRegion from "./ScrollRegion";

/**
 * "Your programs and work streams": the work streams the person owns and the programs they may manage (owned, or under a work stream they own), work
 * streams first, each row naming its owner: a work stream's is the person (`personName`, a work stream is listed only when they own it), a program's its
 * own `ownerName`. Neither has a page of its own, so the name is the link to the Roadmap filtered to it (the Work stream filter, the program pick with one
 * program); the flags are the Programs page's roll-up over the projects below.
 */
export default function HomeNodesTable({
  workStreams,
  programs,
  personName,
}: {
  workStreams: HomeMe["workStreams"];
  programs: HomeMe["programs"];
  personName: string;
}) {
  const { t } = useTranslation();
  // A node with no project has nothing on the Roadmap: its id is no filter option there, so the link would open the whole Roadmap unfiltered.
  const onRoadmap = (entity: EntityRef, to: string, name: string, projects: number) => (
    <EntityLink entity={projects === 0 ? null : entity} to={to} name={name} size="sm" fw={500} aria-label={t("home.mine.nodeOnRoadmapAria", { name })} />
  );
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
                {onRoadmap(
                  { kind: "workStream", id: stream.id },
                  roadmapFilteredPath({ filters: { workStreamId: stream.id } }),
                  stream.endDate === null ? stream.name : t("plan.move.closedName", { name: stream.name }),
                  stream.projects,
                )}
              </Table.Td>
              <Table.Td>{t("home.mine.level.workStream")}</Table.Td>
              <Table.Td />
              <Table.Td>{personName}</Table.Td>
              <Table.Td ta="right">{stream.programs}</Table.Td>
              <Table.Td ta="right">{stream.projects}</Table.Td>
              <Table.Td>
                <HomeFlagBadges flags={stream.flags} />
              </Table.Td>
            </Table.Tr>
          ))}
          {programs.map((program) => (
            <Table.Tr key={`program-${program.id}`}>
              <Table.Td>{onRoadmap({ kind: "program", id: program.id }, roadmapFilteredPath({ pick: [program.id] }), program.name, program.projects)}</Table.Td>
              <Table.Td>{t("home.mine.level.program")}</Table.Td>
              <Table.Td>{program.workStreamName}</Table.Td>
              <Table.Td>{program.ownerName}</Table.Td>
              <Table.Td />
              <Table.Td ta="right">{program.projects}</Table.Td>
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
