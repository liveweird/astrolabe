import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Select, Stack, Switch, Text } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconPlus, IconUsersGroup } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAdmin } from "../auth";
import { getTeamLoadView, TEAM_LOAD_KEY, type TeamLoadRow } from "../api/teamLoad";
import { deleteTeam, getTeam, type TeamResponse } from "../api/teams";
import ClearableTextInput from "../components/ClearableTextInput";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal";
import EmptyState from "../components/EmptyState";
import ErrorAlert from "../components/ErrorAlert";
import FilterPanel from "../components/FilterPanel";
import LoadingBlock from "../components/LoadingBlock";
import PageHeader from "../components/PageHeader";
import type { SortDir } from "../components/SortHeader";
import TeamEditorModal from "../components/TeamEditorModal";
import TeamLoadWeeks from "../components/TeamLoadWeeks";
import TeamsTable, { TeamsFacts } from "../components/TeamsTable";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { FILTER_DEBOUNCE_MS } from "../hooks/usePagedSort";
import { useStoredState } from "../hooks/useStoredState";
import { useTeamColours } from "../hooks/useTeamColours";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { teamPath } from "../utils/teamLinks";
import { earlierWeekCount, isNarrowing, parseTeamLoadFilter, teamLoadFilterParams, teamsKept } from "../utils/teamLoadFilters";

const CHOICES = ["all", "overloaded", "wip", "any"] as const;
type Choice = (typeof CHOICES)[number];

const isSortDir = (value: unknown) => value === "asc" || value === "desc";

/**
 * The Teams page (`/teams`, 1.32: the Team load page folded into it): ONE table of every team with its manager, milestones, the ones not scheduled and
 * its overloaded, over-WIP and without-capacity weeks, from the one unpaged `GET /views/team-load` (at most 200 rows, `truncated` says so; the colour
 * comes from the cached teams read, no view names it). Everyone reads it; an ADMIN also creates, edits and deletes teams (a modal per team, the row's kebab).
 * "Show" (`?warning=`) and "Include past weeks" (`?past=true`) live in the URL (a change `replace`s the entry, so Home's two capacity badges, the old
 * `/team-load` address, a reload and Back all restore the view); the Name filter is page state (as you type, not in the URL, not remembered). The filters only
 * hide rows and weeks: the facts line always shows the document's totals, and "Showing N of M teams" says when the table is narrower than the document.
 * Under the table, "Weeks with a warning" (`components/TeamLoadWeeks.tsx`) lists the weeks behind the two warning figures for the teams shown (1.21), from the
 * DOCUMENT's `currentWeekStart` on (the server's Monday, never the browser's clock) unless `past` asks for the earlier ones; while they are hidden one dimmed
 * line counts them. Only the name sorts; descending reverses the document's order, and the direction is remembered.
 */
export default function Teams() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const admin = useAdmin();
  const [params, setParams] = useSearchParams();
  const filter = parseTeamLoadFilter(params);
  const [name, setName] = useState("");
  const [sortDir, setSortDir] = useStoredState<SortDir>("teams.sortDir", "asc", isSortDir);
  const { data, isLoading, isError, error } = useQuery({ queryKey: TEAM_LOAD_KEY, queryFn: getTeamLoadView });
  const colours = useTeamColours();

  // The editor takes the DETAIL shape (it prefills from it); the document's row only has the summary, so Edit fetches the team first - through the
  // detail query key, so the page shares the cache.
  const [editorTarget, setEditorTarget] = useState<TeamResponse | "new" | null>(null);
  // Edit opens after the fetch, long after the click ended: `claim` takes the row menu's kebab in the click itself.
  const { claim } = useDialogFocus(editorTarget !== null);
  async function openEditor(row: TeamLoadRow) {
    const team = await claim(queryClient.fetchQuery({ queryKey: ["teams", "detail", row.id], queryFn: () => getTeam(row.id) }));
    setEditorTarget(team);
  }
  // A team write moves the team (the cached teams reads) and every plan view that shows it: this page's document, Home, the team page.
  const refreshAfterWrite = () => refreshQueriesAfterMutation(queryClient, ["teams"], ["plan"]);

  const titleRef = useRef<HTMLHeadingElement>(null);
  const remove = useDeleteConfirm<TeamLoadRow>({
    mutationFn: (row) => deleteTeam(row.id),
    onSuccess: refreshAfterWrite,
    successMessage: t("teams.toast.deleted"),
    focusAfterDelete: titleRef,
  });

  const choose = (choice: Choice) => setParams(teamLoadFilterParams({ ...filter, warning: choice === "all" ? undefined : choice }), { replace: true });
  const choosePast = (past: boolean) => setParams(teamLoadFilterParams({ ...filter, past: past ? true : undefined }), { replace: true });
  const all = data?.teams ?? [];
  const narrowing = { warning: filter.warning, name };
  const kept = teamsKept(all, narrowing);
  const rows = sortDir === "asc" ? kept : [...kept].reverse();
  // Only the ANNOUNCED count waits for typing to pause (the rows follow every keystroke); an emptied name is announced at once.
  const [settledName] = useDebouncedValue(name.trim(), FILTER_DEBOUNCE_MS);
  const announced = { warning: filter.warning, name: name.trim() === "" ? "" : settledName };
  // The weeks the page lists start at the document's own current week (the server's), unless the switch asks for the earlier ones.
  const from = filter.past === true ? undefined : data?.currentWeekStart;
  const hiddenWeeks = data === undefined || from === undefined ? 0 : earlierWeekCount(kept, filter.warning, from);
  // An empty list is a claim about a READ: made only from an answer, never over a failed refresh.
  const settled = data !== undefined && !isError;

  return (
    <Stack gap="md">
      <PageHeader
        titleRef={titleRef}
        title={t("teams.title")}
        description={t("teams.intro")}
        actions={
          admin && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setEditorTarget("new")}>
              {t("teams.newTeam")}
            </Button>
          )
        }
      />

      <FilterPanel activeFilterCount={(name.trim() === "" ? 0 : 1) + (filter.warning === undefined ? 0 : 1) + (filter.past === true ? 1 : 0)} storageKey="teams">
        <ClearableTextInput label={t("common.field.name")} value={name} onChange={setName} clearLabel={t("common.filter.clearName")} />
        <Select
          label={t("teamLoad.filter.warning")}
          data={CHOICES.map((choice) => ({ value: choice, label: t(`teamLoad.warning.${choice}`) }))}
          value={filter.warning ?? "all"}
          onChange={(selected) => selected !== null && choose(selected as Choice)}
          allowDeselect={false}
        />
        <Switch label={t("teamLoad.filter.past")} checked={filter.past === true} onChange={(event) => choosePast(event.currentTarget.checked)} pb={6} />
      </FilterPanel>

      {isError && <ErrorAlert error={error} title={t("teams.loadFailed")} />}
      {isLoading && <LoadingBlock />}
      {data && (
        <Stack gap={4}>
          <TeamsFacts totals={data.totals} />
          <Text size="sm" c="dimmed" role="status">
            {isNarrowing(announced) ? t("teams.shownOf", { shown: teamsKept(all, announced).length, count: all.length }) : null}
          </Text>
        </Stack>
      )}

      {settled && data.totals.teams === 0 && <EmptyState icon={IconUsersGroup} label={t("teams.empty")} />}
      {settled && !data.truncated && data.totals.teams > 0 && rows.length === 0 && (
        <Stack gap="sm" align="center">
          <EmptyState icon={IconUsersGroup} label={t("teams.noMatch")} />
          <Button
            variant="default"
            size="compact-sm"
            onClick={() => {
              setName("");
              choose("all");
            }}
          >
            {t("teamLoad.showAll")}
          </Button>
        </Stack>
      )}
      {data && rows.length > 0 && (
        <TeamsTable
          rows={rows}
          colours={colours}
          admin={admin}
          sortDir={sortDir}
          onToggleSort={() => setSortDir(sortDir === "asc" ? "desc" : "asc")}
          onEdit={(row) => void openEditor(row)}
          onDelete={remove.requestDelete}
        />
      )}
      {data?.truncated && (
        <Text size="sm" c="dimmed">
          {t("teamLoad.truncated", { count: data.teams.length })}
        </Text>
      )}
      {data && <TeamLoadWeeks rows={kept} warning={filter.warning} from={from} />}
      {hiddenWeeks > 0 && (
        // Shown whether or not the section is: a team with "3 weeks overloaded" and no week below is never a riddle.
        <Text size="sm" c="dimmed">
          {t("teamLoad.weeks.earlier", { count: hiddenWeeks })}
        </Text>
      )}
      {data?.warningWeeksTruncated && (
        // Whenever the document was cut, also when the section is absent or short: an absent list is never read as "none".
        <Text size="sm" c="dimmed">
          {t("teamLoad.weeks.truncated", { count: data.teams.reduce((sum, row) => sum + row.warningWeeks.length, 0) })}
        </Text>
      )}

      {editorTarget !== null && (
        <TeamEditorModal
          target={editorTarget === "new" ? null : editorTarget}
          onClose={() => setEditorTarget(null)}
          onSaved={async (saved) => {
            setEditorTarget(null);
            await refreshAfterWrite();
            // A NEW team lands on its page.
            if (saved) navigate(teamPath(saved.id));
          }}
        />
      )}

      <ConfirmDeleteModal
        confirm={remove}
        title={t("teams.deleteTitle")}
        errorTitle={t("teams.deleteFailed")}
        errorMessage={(err) =>
          saveErrorMessage(err, t, {
            conflict: "teams.deleteConflict",
            failedStatus: "common.error.actionFailedStatus",
            failed: "common.error.actionFailed",
          })
        }
        body={(team) => t("teams.deleteBody", { name: team.name })}
      />
    </Stack>
  );
}
