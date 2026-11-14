import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, Group, Loader, Stack, Table, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { listTeams } from "../api/teams";
import type { JiraImportMatch } from "../api/jira";
import type { PreviewState } from "../hooks/useJiraImport";
import { useImportMatches } from "../hooks/useImportMatches";
import {
  allSelectable,
  blockingParent,
  carriedPicks,
  carriedTicks,
  type ImportConnection,
  type ImportRoot,
  indexItems,
  isSelectable,
  type PreviewCarry,
  searchItems,
  tickRow,
  tickShown,
  unscheduledForRights,
} from "../utils/jiraImport";
import type { ImportFailure } from "../utils/jiraImportText";
import ClearableTextInput from "./ClearableTextInput";
import JiraImportFailureAlert from "./JiraImportFailureAlert";
import JiraImportMatchNote from "./JiraImportMatchNote";
import JiraImportPreviewNotes from "./JiraImportPreviewNotes";
import JiraImportRow, { IMPORT_ROW_HEIGHT, type TeamOption } from "./JiraImportRow";
import JiraImportVirtualTable from "./JiraImportVirtualTable";
import type { PickedOption } from "./SearchPicker";

/** A row's owner pick put into (or, for a cleared picker, taken out of) the map: no pick means the dialog's owner. */
function withPick(previous: ReadonlyMap<string, PickedOption>, id: string, pick: PickedOption | null): ReadonlyMap<string, PickedOption> {
  const next = new Map(previous);
  if (pick === null) next.delete(id);
  else next.set(id, pick);
  return next;
}

/** The second phase: what the import would do, with a tickbox per row that would be written. The ticks and the per-row team overrides are this component's state. */
export default function JiraImportPreviewStep({
  connection,
  root,
  owner,
  preview,
  carry,
  busy,
  failure,
  onApply,
  onBack,
  onPreviewAgain,
}: {
  connection: ImportConnection;
  /** The dialog's owner, which every program and project row gets unless its own picker says otherwise (null: no per-row owner picker). */
  owner: PickedOption | null;
  /** A rooted import (1.14): an empty preview says what Jira listed under the root's key, not that the scope is empty. */
  root?: ImportRoot;
  preview: PreviewState;
  /** The previous step's work (ticks, overrides, owner picks) when this preview was a match-driven "Preview again"; null/absent = start afresh. */
  carry?: PreviewCarry | null;
  busy: "preview" | "apply" | null;
  failure: ImportFailure | null;
  onApply: (ticks: ReadonlySet<string>, teamOverrides: ReadonlyMap<string, number>, ownerOverrides: ReadonlyMap<string, number>) => void;
  onBack: () => void;
  /** Reads Jira again with the scope the rows were read under; `matches` replaces the scope's confirmed matches (the pending changes applied), `carry` is the work to keep. */
  onPreviewAgain: (matches?: readonly JiraImportMatch[], carry?: PreviewCarry) => void;
}) {
  const { t } = useTranslation();
  const { data, scope } = preview;
  const { items, totals } = data;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  const index = useMemo(() => indexItems(items), [items]);
  const selectable = useMemo(() => items.filter(isSelectable).length, [items]);
  const [ticks, setTicks] = useState<ReadonlySet<string>>(() => (carry ? carriedTicks(items, carry) : allSelectable(items)));
  const [overrides, setOverrides] = useState<ReadonlyMap<string, number>>(() => (carry ? carriedPicks(items, carry, carry.teams) : new Map()));
  const [ownerPicks, setOwnerPicks] = useState<ReadonlyMap<string, PickedOption>>(() => (carry ? carriedPicks(items, carry, carry.owners) : new Map()));
  const [announcement, setAnnouncement] = useState("");
  const [query, setQuery] = useState("");
  // Suggested matches (1.15): a click records a change and nothing else; Import waits until the preview is read again with it.
  const matches = useImportMatches(scope, items, onPreviewAgain);
  const teams = useQuery({ queryKey: ["teams", "picker", "import"], queryFn: () => listTeams({ page: 1, pageSize: 100, sort: "name" }) });
  const teamOptions: TeamOption[] | null = teams.data ? teams.data.items.map((team) => ({ value: String(team.id), label: team.name })) : null;
  // Orange only when a skip needs a look: rows that are simply already linked are fine.
  const notable = items.some((item) => item.action === "SKIP" && item.reason !== "ALREADY_BOUND");
  const rights = unscheduledForRights(items, ticks, scope.copyDates);
  const truncated = totals.truncated;
  const filter = scope.filter ?? null;
  // The search only HIDES rows: the ticks, the overrides and the global counts below never look at it. Select all / none and the header checkbox act on what is shown.
  const searching = query.trim() !== "";
  const narrowed = searching || matches.onlyMatches;
  const { narrow } = matches;
  const shown = useMemo(() => narrow(searchItems(items, query)), [items, query, narrow]);
  const shownSelectable = useMemo(() => shown.filter(isSelectable), [shown]);
  const shownTicked = shownSelectable.filter((item) => ticks.has(item.jiraId)).length;
  const none = ticks.size === 0;
  const applying = busy === "apply";
  const locked = busy !== null;
  const { waiting } = matches;
  // One "Preview again" for the footer, the failure alert and the banner: with changes waiting it carries them and the user's work on the rows.
  const previewAgain = () => matches.previewAgain({ items, ticks, teams: overrides, owners: ownerPicks });

  function tick(id: string, on: boolean) {
    const result = tickRow(index, ticks, id, on);
    setTicks(result.ticks);
    const key = index.byId.get(id)?.issueKey ?? id;
    setAnnouncement(result.alsoChanged === 0 ? "" : t(on ? "jira.import.preview.alsoTicked" : "jira.import.preview.alsoUnticked", { key, count: result.alsoChanged }));
  }

  function setShown(on: boolean) {
    const result = tickShown(index, ticks, shown, on);
    setTicks(result.ticks);
    setAnnouncement(result.alsoChanged === 0 ? "" : t(on ? "jira.import.preview.alsoTickedShown" : "jira.import.preview.alsoUntickedShown", { count: result.alsoChanged }));
  }

  return (
    <Stack gap="sm">
      <Title order={3} size="h4" ref={headingRef} tabIndex={-1}>
        {t("jira.import.preview.title")}
      </Title>
      <JiraImportPreviewNotes totals={totals} notable={notable} filter={filter} root={root} rights={rights} unmatchedTeams={data.unmatchedTeams} />
      <JiraImportMatchNote
        suggestions={matches.suggestions}
        hasChoices={matches.hasChoices}
        filtered={filter !== null}
        onlyMatches={matches.onlyMatches}
        onOnlyMatches={(on) => {
          matches.setOnlyMatches(on);
          setAnnouncement("");
        }}
        pendingCount={matches.pending.size}
        onPreviewAgain={previewAgain}
        locked={locked}
      />
      {items.length > 0 && (
        <Group gap="sm" align="flex-end">
          <ClearableTextInput
            label={t("jira.import.preview.searchLabel")}
            placeholder={t("jira.import.preview.searchPlaceholder")}
            clearLabel={t("jira.import.preview.searchClear")}
            value={query}
            onChange={(value) => {
              setQuery(value);
              // A "… outside the search" sentence is about the search it was made under.
              setAnnouncement("");
            }}
          />
          {/* Always mounted (so a change is announced); empty without a search. */}
          <Text size="sm" role="status" pb={6}>
            {narrowed ? t("jira.import.preview.showing", { shown: shown.length, total: items.length }) : ""}
          </Text>
        </Group>
      )}
      <Group gap="sm" align="center">
        <Button variant="default" size="compact-sm" onClick={() => setShown(true)} disabled={truncated || shownSelectable.length === 0 || locked}>
          {t(narrowed ? "jira.import.preview.tickShown" : "jira.import.preview.selectAll")}
        </Button>
        <Button variant="default" size="compact-sm" onClick={() => setShown(false)} disabled={shownTicked === 0 || locked}>
          {t(narrowed ? "jira.import.preview.untickShown" : "jira.import.preview.selectNone")}
        </Button>
        <Text size="sm">{t("jira.import.preview.selected", { ticked: ticks.size, total: selectable })}</Text>
        {/* The live region stays mounted (so a change is announced) but sits in this row: empty, it reserves no height of its own. */}
        <Text size="sm" role="status">
          {announcement}
        </Text>
      </Group>
      {items.length === 0 && root !== undefined ? (
        <Stack gap={4} role="note">
          <Text size="sm">{t("jira.import.preview.rootEmpty", { key: root.issueKey })}</Text>
          {filter !== null && <Text size="sm">{t("jira.import.preview.rootEmptyFilter")}</Text>}
          <Text size="sm">{t("jira.import.preview.rootEmptyCheck", { key: root.issueKey })}</Text>
        </Stack>
      ) : items.length === 0 ? (
        <Text size="sm" role="note">
          {t(filter === null ? "jira.import.preview.empty" : "jira.import.preview.emptyFiltered")}
        </Text>
      ) : shown.length === 0 ? (
        <Text size="sm" role="note">
          {t("jira.import.preview.noMatch", { query: query.trim() })}
        </Text>
      ) : (
        <JiraImportVirtualTable
          label={t("jira.import.preview.tableAria")}
          count={shown.length}
          rowHeight={IMPORT_ROW_HEIGHT}
          minWidth={940}
          maxHeight={460}
          columns={5}
          header={
            <Table.Tr aria-rowindex={1}>
              <Table.Th w={44}>
                <Checkbox
                  aria-label={t(narrowed ? "jira.import.preview.selectShownAria" : "jira.import.preview.selectAllAria")}
                  checked={shownSelectable.length > 0 && shownTicked === shownSelectable.length}
                  indeterminate={shownTicked > 0 && shownTicked < shownSelectable.length}
                  disabled={truncated || shownSelectable.length === 0 || locked}
                  onChange={(event) => setShown(event.currentTarget.checked)}
                />
              </Table.Th>
              <Table.Th>{t("jira.import.preview.column.item")}</Table.Th>
              <Table.Th>{t("jira.import.preview.column.plan")}</Table.Th>
              <Table.Th>{t("jira.import.preview.column.action")}</Table.Th>
              <Table.Th>{t("jira.import.preview.column.details")}</Table.Th>
            </Table.Tr>
          }
          renderRow={(row, rowProps) => {
            const item = shown[row];
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
                owner={owner === null ? null : (ownerPicks.get(item.jiraId) ?? owner)}
                ownerPicked={ownerPicks.has(item.jiraId)}
                onOwner={(pick) => setOwnerPicks((previous) => withPick(previous, item.jiraId, pick))}
                matchChange={matches.pending.get(item.jiraId)}
                locked={locked}
                onMatch={(change) => matches.setChange(item.jiraId, change)}
                rowProps={rowProps}
              />
            );
          }}
        />
      )}
      {failure && <JiraImportFailureAlert failure={failure} onPreviewAgain={previewAgain} disabled={locked} />}
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
          {/* While changes to the matches wait, the banner's button is the one "Preview again" (so the name is never doubled). */}
          {!waiting && (
            <Button variant="default" onClick={previewAgain} disabled={locked}>
              {t("jira.import.previewAgain")}
            </Button>
          )}
        </Group>
        <Button onClick={() => onApply(ticks, overrides, new Map([...ownerPicks].map(([id, pick]) => [id, Number(pick.value)])))} loading={applying} disabled={none || truncated || locked || waiting}>
          {t("jira.import.preview.import", { n: ticks.size })}
        </Button>
      </Group>
    </Stack>
  );
}
