import { Stack, Table, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { TeamCriticalChain as ChainBlock, TeamView } from "../api/teams";
import { criticalArrowRows } from "../utils/teamChain";
import { DependencyEndCell, DependencyLagText } from "./DependencyCells";
import ScrollRegion from "./ScrollRegion";
import TableDisclosure from "./TableDisclosure";

const NO_WRAP = { whiteSpace: "nowrap" } as const;
const TABLE_MAX_HEIGHT = 420;

/**
 * The note under the timeline's title while the toggle is on (`id` is what the toggle's `aria-describedby` names): the figures are toward each milestone's
 * OWN project's end and what the dimmed rows are; when the server cut the chain at its cap, a dimmed line says that too.
 */
export function TeamCriticalNote({ id, chain }: { id: string; chain: ChainBlock | undefined }) {
  const { t } = useTranslation();
  return (
    <>
      <Text size="sm" c="dimmed" id={id}>
        {t("teams.view.criticalNote")}
      </Text>
      {chain?.truncated === true && (
        <Text size="sm" c="dimmed">
          {t("teams.view.chain.truncated", { count: chain.members.length })}
        </Text>
      )}
    </>
  );
}

/**
 * The Critical chain section of the team page (1.27, mounted only while the critical-path toggle is on and the page has a critical arrow): the ACCESSIBLE
 * surface of the critical arrows, which are `aria-hidden` decoration. One sentence with the number of ghost rows the chain added, a dimmed line when the
 * server cut the chain at its cap, and - behind a disclosure - one table row per critical dependency of the chain: predecessor and successor each with their
 * project and team as links, the type and the lag. Information only; nothing moves. The rows are the team's own critical links and the block's
 * (`criticalArrowRows`); with none the page has no section. `chain` is `undefined` while the document is the plain one on its way.
 */
export default function TeamCriticalChain({ view, chain }: { view: Pick<TeamView, "dependencies">; chain: ChainBlock | undefined }) {
  const { t } = useTranslation();
  const rows = criticalArrowRows(view, chain);
  if (rows.length === 0) return null;
  const memberCount = chain?.members.length ?? 0;
  const label = t("teams.view.chain.tableAria");
  return (
    <Stack gap="xs">
      <Title order={3} size="h4">
        {t("teams.view.chain.title")}
      </Title>
      {/* Nothing is said of a chain that has not arrived: the plain document is on screen, with the team's own critical links alone. */}
      {chain !== undefined && (
        <Text size="sm" c="dimmed">
          {memberCount === 0 ? t("teams.view.chain.introNone") : t("teams.view.chain.intro", { count: memberCount })}
        </Text>
      )}
      {chain?.truncated === true && (
        <Text size="sm" c="dimmed">
          {t("teams.view.chain.truncated", { count: memberCount })}
        </Text>
      )}
      <TableDisclosure showLabel={t("teams.view.chain.show")} hideLabel={t("teams.view.chain.hide")}>
        <ScrollRegion label={label} minWidth={640} maxHeight={TABLE_MAX_HEIGHT}>
          <Table aria-label={label} stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("project.dependency.column.predecessor")}</Table.Th>
                <Table.Th>{t("project.dependency.column.successor")}</Table.Th>
                <Table.Th>{t("project.dependency.column.type")}</Table.Th>
                <Table.Th>{t("project.dependency.column.lag")}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.id}>
                  <Table.Td>
                    <DependencyEndCell end={row.predecessor} />
                  </Table.Td>
                  <Table.Td>
                    <DependencyEndCell end={row.successor} />
                  </Table.Td>
                  <Table.Td style={NO_WRAP}>{t(`project.dependency.type.${row.type}`)}</Table.Td>
                  <Table.Td style={NO_WRAP}>
                    <DependencyLagText lagDays={row.lagDays} />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollRegion>
      </TableDisclosure>
    </Stack>
  );
}
