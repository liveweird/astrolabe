import { Badge, Group, Stack, Table, Text, Title } from "@mantine/core";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { BaselineLinkEnd, BaselineLinks, BaselineLinkTerms } from "../api/baselines";
import { DependencyLagText } from "./DependencyCells";
import ScrollRegion from "./ScrollRegion";

const NO_WRAP = { whiteSpace: "nowrap" } as const;
const TABLE_MAX_HEIGHT = 420;

/** One end of a changed link in words: a project end as the dependency tables word it, a milestone with the project it belongs to. */
function endText(end: BaselineLinkEnd, t: TFunction): string {
  if (end.kind === "PROJECT") return t("project.dependency.wholeProject", { name: end.name });
  return end.projectName === null ? end.name : `${end.name} · ${end.projectName}`;
}

/** One side of a changed link: its type and lag, "—" for the side that has no such link. */
function Terms({ terms }: { terms: BaselineLinkTerms | null }) {
  const { t } = useTranslation();
  if (terms === null) return <>—</>;
  return (
    <>
      {t(`project.dependency.type.${terms.type}`)} · <DependencyLagText lagDays={terms.lagDays} />
    </>
  );
}

/**
 * The Links section of the comparison page (1.26, h3): the links the baseline froze against the links now (or the other baseline's), by dependency
 * id. The server's totals as gray badges (a link change is information, never a warning), then ONLY the changed links (added, removed, changed -
 * at most 1,000, `truncated` says so). `captured` false is UNKNOWN, not "no links": the baseline (or, with `sides`, one of the two) was taken
 * before baselines froze links, and the section says so instead of drawing an empty comparison.
 */
export default function BaselineLinksSection({ links, sides }: { links: BaselineLinks; sides: { then: string; now: string } | null }) {
  const { t } = useTranslation();
  const { totals, items } = links;
  const parts = (["added", "removed", "changed", "unchanged"] as const).filter((key) => totals[key] > 0);
  const tableLabel = t("baselines.compare.links.tableAria");
  return (
    <Stack gap="sm">
      <Title order={3} size="h4">
        {t("baselines.compare.links.title")}
      </Title>
      {!links.captured ? (
        <Text size="sm" c="dimmed">
          {t(sides === null ? "baselines.compare.links.notCaptured" : "baselines.compare.links.notCapturedAgainst")}
        </Text>
      ) : (
        <>
          <Text size="sm" c="dimmed">
            {t("baselines.compare.links.intro")}
          </Text>
          <Group gap="xs" wrap="wrap">
            {totals.added + totals.removed + totals.changed === 0 && (
              <Text size="sm" c="dimmed" component="span">
                {t("baselines.compare.links.none")}
              </Text>
            )}
            {parts.map((key) => (
              <Badge key={key} color="gray" tt="none">
                {t(`baselines.compare.links.totals.${key}`, { count: totals[key] })}
              </Badge>
            ))}
          </Group>
          {items.length > 0 && (
            <ScrollRegion label={tableLabel} minWidth={980} maxHeight={TABLE_MAX_HEIGHT}>
              <Table aria-label={tableLabel} stickyHeader>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t("baselines.compare.links.column.change")}</Table.Th>
                    <Table.Th>{t("baselines.compare.links.column.predecessor")}</Table.Th>
                    <Table.Th>{t("baselines.compare.links.column.successor")}</Table.Th>
                    <Table.Th>{sides === null ? t("baselines.compare.column.baseline") : t("baselines.compare.column.then", sides)}</Table.Th>
                    <Table.Th>{sides === null ? t("baselines.compare.column.current") : t("baselines.compare.column.now", sides)}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {items.map((item) => (
                    <Table.Tr key={item.dependencyId}>
                      <Table.Td style={NO_WRAP}>
                        <Badge color="gray" tt="none" miw="max-content">
                          {t(`baselines.compare.links.change.${item.change}`)}
                        </Badge>
                      </Table.Td>
                      <Table.Td>{endText(item.predecessor, t)}</Table.Td>
                      <Table.Td>{endText(item.successor, t)}</Table.Td>
                      <Table.Td>
                        <Terms terms={item.then} />
                      </Table.Td>
                      <Table.Td>
                        <Terms terms={item.now} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollRegion>
          )}
          {links.truncated && (
            <Text size="sm" c="dimmed" role="note">
              {t("baselines.compare.links.truncated", { count: items.length })}
            </Text>
          )}
        </>
      )}
    </Stack>
  );
}
