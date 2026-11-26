import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Select } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listMilestones } from "../api/milestones";
import { getPlanView, planViewKey } from "../api/plan";
import { FILTER_DEBOUNCE_MS } from "../hooks/usePagedSort";
import { projectPath } from "../utils/planLinks";
import {
  MILESTONE_SEARCH_LIMIT,
  MILESTONE_TERM_MIN,
  milestoneNamesByProject,
  pickedLabel,
  projectOptionsFilter,
  projectPickerOptions,
  withMilestoneHits,
  type ProjectPickerItem,
} from "../utils/projectPicker";
import ProjectPickerOption from "./ProjectPickerOption";

/**
 * The project picker (1.29): a searchable `Select` over the cached plan view, the one way between projects. Options are grouped "Work stream › Program"
 * (a closed work stream is marked), and the search matches the project, program, work stream and owner names, accents folded. It is never clearable
 * (a project page always has a project; the bare `/projects` shows none until one is picked) and a pick is a push to the project's page, so Back returns.
 * `projectId` is the project shown (`null` = none); `currentName` names it for a page whose plan view has not answered or does not hold it.
 * The control has no visible label (it sits where the back link was): its accessible name is the plain noun, never "… picker" (the role says that).
 *
 * 1.30: it also finds a project by the name of one of its milestones, which the plan view does not hold: from `MILESTONE_TERM_MIN` characters the term
 * (debounced, and never the picked project's own name that the control writes into its box: `SearchPicker`'s guard) asks `GET /milestones?name=`, the
 * first `MILESTONE_SEARCH_LIMIT` by name, and a project with a milestone in the answer joins the options under its own name with a "Milestone: X" line. "Nothing found"
 * waits for that search; a cut or failed one is a disabled line at the end of the dropdown (the matches by project, program and owner stay).
 */
export default function ProjectPicker({ projectId, currentName }: { projectId: number | null; currentName?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const plan = useQuery({ queryKey: planViewKey, queryFn: getPlanView });
  const closedMark = t("project.picker.closedStream");
  const base = useMemo(
    () => projectPickerOptions(plan.data, closedMark, projectId !== null && currentName !== undefined ? { id: projectId, name: currentName } : undefined),
    [plan.data, closedMark, projectId, currentName],
  );
  // Choosing an option makes Mantine put its label into the box: that is not a search term.
  const [searchValue, setSearchValue] = useState("");
  const term = searchValue === pickedLabel(base, projectId) ? "" : searchValue.trim();
  const [debounced] = useDebouncedValue(term, FILTER_DEBOUNCE_MS);
  const active = term.length >= MILESTONE_TERM_MIN;
  const milestones = useQuery({
    queryKey: ["plan", "milestones", "projectPicker", debounced],
    queryFn: () => listMilestones({ page: 1, pageSize: MILESTONE_SEARCH_LIMIT, sort: "name", name: debounced }),
    enabled: debounced.length >= MILESTONE_TERM_MIN,
    placeholderData: keepPreviousData,
  });
  const searching = active && (term !== debounced || milestones.isFetching);
  const failed = active && !searching && milestones.isError;
  const cut = active && !searching && (milestones.data?.total ?? 0) > MILESTONE_SEARCH_LIMIT;
  const notice = failed ? t("project.picker.milestonesFailed") : cut ? t("project.picker.milestonesCut", { limit: MILESTONE_SEARCH_LIMIT }) : undefined;
  const data = useMemo(
    () => withMilestoneHits(base, active ? milestoneNamesByProject(milestones.data?.items ?? []) : new Map(), notice),
    [base, active, milestones.data, notice],
  );
  return (
    <Select
      aria-label={t("common.filter.project")}
      placeholder={t("project.picker.placeholder")}
      data={data}
      value={projectId === null ? null : String(projectId)}
      onChange={(picked) => {
        if (picked !== null && Number(picked) !== projectId) navigate(projectPath(Number(picked)));
      }}
      searchValue={searchValue}
      onSearchChange={setSearchValue}
      filter={projectOptionsFilter}
      renderOption={({ option, checked }) => <ProjectPickerOption option={option as ProjectPickerItem} checked={checked} />}
      nothingFoundMessage={searching ? undefined : t("project.picker.nothingFound")}
      aria-busy={searching}
      searchable
      clearable={false}
      allowDeselect={false}
      w={360}
      maw="100%"
    />
  );
}
