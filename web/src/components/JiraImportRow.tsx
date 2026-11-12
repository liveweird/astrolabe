import { useTranslation } from "react-i18next";
import { Badge, Checkbox, NativeSelect, Table, Text } from "@mantine/core";
import type { TFunction } from "i18next";
import type { JiraImportItem } from "../api/jira";
import { infoText, reasonText } from "../utils/jiraImportText";
import JiraKeyLink from "./JiraKeyLink";
import type { VirtualRowProps } from "./JiraImportVirtualTable";

/**
 * One fixed height for every preview row (the virtualiser's contract). The tallest cell is the details one: a 30 px team select, a dates line
 * that may wrap to two lines, one info line. Clamped text stays whole in the DOM (and in its `title`).
 */
export const IMPORT_ROW_HEIGHT = 88;

export type TeamOption = { value: string; label: string };

const levelKey = (level: JiraImportItem["level"]) => `jira.mapping.level.${level.toLowerCase() as "program" | "project" | "milestone"}` as const;

/** Where a CREATE lands / what a BIND links to, in words. Absent for a SKIP row. */
function landingText(item: JiraImportItem, t: TFunction): string | null {
  if (item.action === "BIND") return item.target ? t("jira.import.row.linksTo", { name: item.target.nodeName }) : null;
  if (item.action !== "CREATE") return null;
  if (item.level === "PROGRAM" || !item.parent) return t("jira.import.row.underStream");
  const key = item.parent.kind === "NEW_ROW" ? "jira.import.row.underNew" : item.parent.kind === "DEFAULT" ? "jira.import.row.underDefault" : "jira.import.row.underExisting";
  return t(key, { name: item.parent.nodeName });
}

/** Dates and the converted estimate on one line; "—" when the row has neither (a redacted or non-milestone row), so no cell is ever blank. */
function figuresText(item: JiraImportItem, t: TFunction, copyDates: boolean): string {
  const parts: string[] = [];
  if (item.startDate && item.endDate) parts.push(t("jira.import.row.dates", { start: item.startDate, end: item.endDate }));
  else if (item.level === "MILESTONE" && item.action === "CREATE") parts.push(t(copyDates ? "jira.import.row.noDates" : "jira.import.row.datesOff"));
  if (item.action === "CREATE" && item.level === "MILESTONE" && item.estimateMd != null) parts.push(t("jira.import.row.estimate", { n: item.estimateMd }));
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function ActionCell({ item, blocker, t }: { item: JiraImportItem; blocker: JiraImportItem | undefined; t: TFunction }) {
  const skip = item.action === "SKIP";
  // Orange = something to look at; an item that is simply already linked is not a warning.
  const color = blocker || (skip && item.reason !== "ALREADY_BOUND") ? "orange" : "gray";
  const label = blocker
    ? t("jira.import.action.notImported")
    : item.action === "CREATE"
      ? t("jira.import.action.create")
      : item.action === "BIND"
        ? t("jira.import.action.bind")
        : t("jira.import.action.skip");
  const note = blocker
    ? t("jira.import.row.parentUnticked", { key: blocker.issueKey })
    : skip && item.reason
      ? reasonText(item.reason, t, item.target?.nodeName)
      : null;
  return (
    <>
      <Badge color={color} variant={item.action === "CREATE" ? "outline" : "light"} tt="none">
        {label}
      </Badge>
      {note !== null && (
        <Text size="xs" c={blocker ? undefined : "dimmed"} lineClamp={3} title={note}>
          {note}
        </Text>
      )}
    </>
  );
}

function DetailsCell({
  item,
  copyDates,
  teams,
  teamId,
  onTeam,
  t,
}: {
  item: JiraImportItem;
  copyDates: boolean;
  teams: readonly TeamOption[] | null;
  teamId: number | null;
  onTeam: (teamId: number) => void;
  t: TFunction;
}) {
  const figures = figuresText(item, t, copyDates);
  const infos = item.infos.map((info) => infoText(info, t)).join(" · ");
  // The row's own team is always an option: a team outside the list the page loaded must not display as another one.
  const own = item.team;
  const teamOptions =
    item.action === "CREATE" && item.level === "MILESTONE" && own != null && teams !== null
      ? teams.some((team) => team.value === String(own.id))
        ? teams
        : [...teams, { value: String(own.id), label: own.name }]
      : null;
  return (
    <>
      {teamOptions !== null && (
        <NativeSelect
          size="xs"
          aria-label={t("jira.import.row.teamAria", { key: item.issueKey })}
          data={teamOptions as TeamOption[]}
          value={String(teamId ?? item.team?.id)}
          onChange={(event) => onTeam(Number(event.currentTarget.value))}
        />
      )}
      {teamOptions === null && item.team && (
        <Text size="xs" lineClamp={1}>
          {t(item.team.rule === "MATCHED" ? "jira.import.row.teamMatched" : "jira.import.row.teamDefault", { name: item.team.name })}
        </Text>
      )}
      <Text size="xs" lineClamp={2} title={figures}>
        {figures}
      </Text>
      {infos !== "" && (
        <Text size="xs" c="dimmed" lineClamp={1} title={infos}>
          {infos}
        </Text>
      )}
    </>
  );
}

/**
 * One preview row. A SKIP row has no checkbox (a dash stands in) and says why in words; an unticked row that lands under an unticked
 * parent says so (`blocker`) before the user submits. The name falls back to the key: a non-admin's SKIP row arrives with an empty summary
 * and `name` = key, and a cell must never be blank. Under an active import filter a non-admin's SKIP row arrives with NO key (null, a blank
 * name and a synthetic `hidden-n` id): the key cell shows a "Hidden" placeholder and the name cell a dash. A milestone's team is a `NativeSelect` (the row's own override, sent as
 * `overrides.teamId`); everything is clamped to the fixed row height.
 */
export default function JiraImportRow({
  item,
  siteUrl,
  copyDates,
  ticked,
  blocker,
  teams,
  teamId,
  onTick,
  onTeam,
  rowProps,
}: {
  item: JiraImportItem;
  siteUrl: string;
  copyDates: boolean;
  ticked: boolean;
  blocker: JiraImportItem | undefined;
  teams: readonly TeamOption[] | null;
  teamId: number | null;
  onTick: (on: boolean) => void;
  onTeam: (teamId: number) => void;
  rowProps: VirtualRowProps;
}) {
  const { t } = useTranslation();
  const name = item.name.trim() === "" ? (item.issueKey ?? "—") : item.name;
  const landing = landingText(item, t);
  const typeLevel = item.typeName ? t("jira.import.row.typeAs", { type: item.typeName, level: t(levelKey(item.level)).toLowerCase() }) : t(levelKey(item.level));
  return (
    <Table.Tr {...rowProps}>
      <Table.Td w={44}>
        {item.action === "SKIP" ? (
          <span aria-hidden="true">–</span>
        ) : (
          <Checkbox checked={ticked} onChange={(event) => onTick(event.currentTarget.checked)} aria-label={t("jira.import.preview.rowAria", { key: item.issueKey })} />
        )}
      </Table.Td>
      <Table.Td w={150}>
        <Text size="sm" fw={500}>
          {item.issueKey === null ? (
            <Text span c="dimmed" title={t("jira.import.row.keyHiddenHint")}>
              {t("jira.import.row.keyHidden")}
            </Text>
          ) : (
            <JiraKeyLink issueKey={item.issueKey} siteUrl={siteUrl} />
          )}
        </Text>
        <Text size="xs" c="dimmed" lineClamp={1} title={typeLevel}>
          {typeLevel}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm" fw={500} lineClamp={1} title={name}>
          {name}
        </Text>
        <Text size="xs" c="dimmed" lineClamp={2} title={landing ?? undefined}>
          {landing ?? "—"}
        </Text>
      </Table.Td>
      <Table.Td w={250}>
        <ActionCell item={item} blocker={blocker} t={t} />
      </Table.Td>
      <Table.Td w={280}>
        <DetailsCell item={item} copyDates={copyDates} teams={teams} teamId={teamId} onTeam={onTeam} t={t} />
      </Table.Td>
    </Table.Tr>
  );
}
