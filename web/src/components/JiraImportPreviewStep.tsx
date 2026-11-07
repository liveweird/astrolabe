import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Badge, Button, Checkbox, Group, Loader, Stack, Table, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { JiraConnection } from "../api/jira";
import { listTeams } from "../api/teams";
import type { PreviewState } from "../hooks/useJiraImport";
import { allSelectable, blockingParent, indexItems, isSelectable, tickRow, unscheduledForRights } from "../utils/jiraImport";
import type { ImportFailure } from "../utils/jiraImportText";
import JiraImportFailureAlert from "./JiraImportFailureAlert";
import JiraImportRow, { IMPORT_ROW_HEIGHT, type TeamOption } from "./JiraImportRow";
import JiraImportVirtualTable from "./JiraImportVirtualTable";

/** The second phase: what the import would do, with a tickbox per row that would be written. The ticks and the per-row team overrides are this component's state. */
export default function JiraImportPreviewStep({
  connection,
  preview,
  busy,
  failure,
  onApply,
  onBack,
  onPreviewAgain,
}: {
  connection: JiraConnection;
  preview: PreviewState;
  busy: "preview" | "apply" | null;
  failure: ImportFailure | null;
  onApply: (ticks: ReadonlySet<string>, teamOverrides: ReadonlyMap<string, number>) => void;
  onBack: () => void;
  onPreviewAgain: () => void;
}) {
  const { t } = useTranslation();
  const { data, scope } = preview;
  const { items, totals } = data;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  const index = useMemo(() => indexItems(items), [items]);
  const selectable = useMemo(() => items.filter(isSelectable).length, [items]);
  const [ticks, setTicks] = useState<ReadonlySet<string>>(() => allSelectable(items));
  const [overrides, setOverrides] = useState<ReadonlyMap<string, number>>(new Map());
  const [announcement, setAnnouncement] = useState("");
  const teams = useQuery({ queryKey: ["teams", "picker", "import"], queryFn: () => listTeams({ page: 1, pageSize: 100, sort: "name" }) });
  const teamOptions: TeamOption[] | null = teams.data ? teams.data.items.map((team) => ({ value: String(team.id), label: team.name })) : null;
  // Orange only when a skip needs a look: rows that are simply already linked are fine.
  const notable = items.some((item) => item.action === "SKIP" && item.reason !== "ALREADY_BOUND");
  const rights = unscheduledForRights(items, ticks, scope.copyDates);
  const truncated = totals.truncated;
  const none = ticks.size === 0;
  const applying = busy === "apply";
  const locked = busy !== null;

  function tick(id: string, on: boolean) {
    const result = tickRow(index, ticks, id, on);
    setTicks(result.ticks);
    const key = index.byId.get(id)?.issueKey ?? id;
    setAnnouncement(result.alsoChanged === 0 ? "" : t(on ? "jira.import.preview.alsoTicked" : "jira.import.preview.alsoUnticked", { key, count: result.alsoChanged }));
  }

  function setAll(on: boolean) {
    setTicks(on ? allSelectable(items) : new Set());
    setAnnouncement("");
  }

  return (
    <Stack gap="sm">
      <Title order={3} size="h4" ref={headingRef} tabIndex={-1}>
        {t("jira.import.preview.title")}
      </Title>
      <Group gap="xs" role="group" aria-label={t("jira.import.preview.totalsAria")}>
        <Badge color="gray" variant="light" tt="none">
          {t("jira.import.preview.totalFound", { n: totals.items })}
        </Badge>
        <Badge color="gray" variant="outline" tt="none">
          {t("jira.import.preview.totalCreate", { n: totals.create })}
        </Badge>
        <Badge color="gray" variant="light" tt="none">
          {t("jira.import.preview.totalBind", { n: totals.bind })}
        </Badge>
        {totals.skip > 0 && (
          <Badge color={notable ? "orange" : "gray"} variant="light" tt="none">
            {t("jira.import.preview.totalSkip", { n: totals.skip })}
          </Badge>
        )}
      </Group>
      {truncated && (
        <Alert color="orange" variant="light" role="note">
          {t("jira.import.preview.truncated")}
        </Alert>
      )}
      {rights.count > 0 && (
        <Text size="sm" role="note">
          {t("jira.import.preview.unscheduledRights", { n: rights.count, of: rights.of })}
        </Text>
      )}
      {data.unmatchedTeams.length > 0 && (
        <Text size="sm" role="note">
          {t("jira.import.preview.unmatchedTeams", { names: data.unmatchedTeams.join(", ") })}
        </Text>
      )}
      <Group gap="sm" align="center">
        <Button variant="default" size="compact-sm" onClick={() => setAll(true)} disabled={truncated || selectable === 0 || locked}>
          {t("jira.import.preview.selectAll")}
        </Button>
        <Button variant="default" size="compact-sm" onClick={() => setAll(false)} disabled={none || locked}>
          {t("jira.import.preview.selectNone")}
        </Button>
        <Text size="sm">{t("jira.import.preview.selected", { ticked: ticks.size, total: selectable })}</Text>
        {/* The live region stays mounted (so a change is announced) but sits in this row: empty, it reserves no height of its own. */}
        <Text size="sm" role="status">
          {announcement}
        </Text>
      </Group>
      {items.length === 0 ? (
        <Text size="sm" role="note">
          {t("jira.import.preview.empty")}
        </Text>
      ) : (
        <JiraImportVirtualTable
          label={t("jira.import.preview.tableAria")}
          count={items.length}
          rowHeight={IMPORT_ROW_HEIGHT}
          minWidth={940}
          maxHeight={460}
          columns={5}
          header={
            <Table.Tr aria-rowindex={1}>
              <Table.Th w={44}>
                <Checkbox
                  aria-label={t("jira.import.preview.selectAllAria")}
                  checked={selectable > 0 && ticks.size === selectable}
                  indeterminate={ticks.size > 0 && ticks.size < selectable}
                  disabled={truncated || selectable === 0 || locked}
                  onChange={(event) => setAll(event.currentTarget.checked)}
                />
              </Table.Th>
              <Table.Th>{t("jira.import.preview.column.item")}</Table.Th>
              <Table.Th>{t("jira.import.preview.column.plan")}</Table.Th>
              <Table.Th>{t("jira.import.preview.column.action")}</Table.Th>
              <Table.Th>{t("jira.import.preview.column.details")}</Table.Th>
            </Table.Tr>
          }
          renderRow={(row, rowProps) => {
            const item = items[row];
            const override = overrides.get(item.jiraId);
            return (
              <JiraImportRow
                item={item}
                siteUrl={connection.siteUrl}
                copyDates={scope.copyDates}
                ticked={ticks.has(item.jiraId)}
                blocker={blockingParent(index, ticks, item)}
                teams={teamOptions}
                teamId={override ?? item.team?.id ?? null}
                onTick={(on) => tick(item.jiraId, on)}
                onTeam={(teamId) => setOverrides((previous) => new Map(previous).set(item.jiraId, teamId))}
                rowProps={rowProps}
              />
            );
          }}
        />
      )}
      {failure && <JiraImportFailureAlert failure={failure} onPreviewAgain={onPreviewAgain} disabled={locked} />}
      {applying && (
        <Group gap="xs" role="status">
          <Loader size="xs" />
          <Text size="sm">{t("jira.import.preview.applying")}</Text>
        </Group>
      )}
      <Group justify="space-between" mt="xs">
        <Group gap="sm">
          <Button variant="default" onClick={onBack} disabled={locked}>
            {t("jira.import.back")}
          </Button>
          <Button variant="default" onClick={onPreviewAgain} disabled={locked}>
            {t("jira.import.previewAgain")}
          </Button>
        </Group>
        <Button onClick={() => onApply(ticks, overrides)} loading={applying} disabled={none || truncated || locked}>
          {t("jira.import.preview.import", { n: ticks.size })}
        </Button>
      </Group>
    </Stack>
  );
}
