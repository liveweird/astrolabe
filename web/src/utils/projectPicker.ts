import type { ComboboxItem, ComboboxItemGroup, ComboboxParsedItem, OptionsFilter } from "@mantine/core";
import type { PlanView } from "../api/plan";
import { openFirstByName } from "./planNames";
import { byNameThenId, foldDiacritics } from "./text";

/**
 * A project option: `search` is every name that may find it (project, program, work stream, owner), matched with the diacritics folded; `milestones` (1.30)
 * are the names of its milestones the milestone search found, which the filter narrows to the live search and the option lists under its own name;
 * `notice` marks the one disabled line the dropdown ends with when the milestone search failed or was cut.
 */
export type ProjectPickerItem = ComboboxItem & { search: string; milestones?: readonly string[]; notice?: true };

/** The milestone search starts at this many characters (a shorter term would list the plan's first hundred milestones) and reads this many rows. */
export const MILESTONE_TERM_MIN = 2;
export const MILESTONE_SEARCH_LIMIT = 100;

/** The value of the notice line (a project id is never this). */
const NOTICE_VALUE = "notice";

/** The group separator of "Work stream › Program". */
const GROUP_SEPARATOR = " › ";

/**
 * The project picker's options over the plan view: one group per program, labelled "Work stream › Program" (a closed work stream carries `closedMark`
 * after its name), open streams first then by name, programs and projects by name. A project outside the plan view (`current`, a page still
 * loading its view) stands alone as an ungrouped option last, so the control can always name the project it shows.
 */
export function projectPickerOptions(plan: PlanView | undefined, closedMark: string, current?: { id: number; name: string }): (ProjectPickerItem | ComboboxItemGroup<ProjectPickerItem>)[] {
  const groups: ComboboxItemGroup<ProjectPickerItem>[] = [];
  let found = false;
  for (const stream of openFirstByName(plan?.workStreams ?? [])) {
    const streamName = stream.endDate === null ? stream.name : `${stream.name} ${closedMark}`;
    for (const program of [...stream.programs].sort(byNameThenId)) {
      const items = [...program.projects].sort(byNameThenId).map((project) => {
        if (project.id === current?.id) found = true;
        return { value: String(project.id), label: project.name, search: [project.name, program.name, stream.name, project.ownerName].join(" ") };
      });
      if (items.length > 0) groups.push({ group: `${streamName}${GROUP_SEPARATOR}${program.name}`, items });
    }
  }
  if (current === undefined || found) return groups;
  return [...groups, { value: String(current.id), label: current.name, search: current.name }];
}

type PickerOptions = ReturnType<typeof projectPickerOptions>;

/** The milestone names grouped by their project, in the order the rows came (the server sorts by name), a repeated name once. */
export function milestoneNamesByProject(rows: readonly { projectId: number; name: string }[]): Map<number, string[]> {
  const byProject = new Map<number, string[]>();
  for (const { projectId, name } of rows) {
    const names = byProject.get(projectId) ?? [];
    if (!names.includes(name)) names.push(name);
    byProject.set(projectId, names);
  }
  return byProject;
}

/** The options with each project's found milestones attached and, when there is one, the notice as the last line (disabled: it is no choice). */
export function withMilestoneHits(options: PickerOptions, hits: ReadonlyMap<number, readonly string[]>, notice?: string): PickerOptions {
  const attach = (item: ProjectPickerItem): ProjectPickerItem => {
    const names = hits.get(Number(item.value));
    return names === undefined ? item : { ...item, milestones: names };
  };
  const withHits = hits.size === 0 ? options : options.map((option) => ("group" in option ? { ...option, items: option.items.map(attach) } : attach(option)));
  return notice === undefined ? withHits : [...withHits, { value: NOTICE_VALUE, label: notice, search: "", disabled: true, notice: true }];
}

/** The label of the option holding `id` (the name the control shows for the project picked), grouped or not. */
export function pickedLabel(options: PickerOptions, id: number | null): string | undefined {
  const value = String(id);
  for (const option of options) {
    const item = "group" in option ? option.items.find((candidate) => candidate.value === value) : option.value === value ? option : undefined;
    if (item !== undefined) return item.label;
  }
  return undefined;
}

/**
 * The picker's own `filter`: the theme's accent-insensitive "contains" (`foldedOptionsFilter`, same grouped-options contract: a group keeps the
 * items that match and disappears when none does), but over everything that names the project, so typing an owner or a program finds its projects,
 * and over its found milestones: a project stays when one of them contains the search (a local re-check of the server's, accents folded) and lists
 * only those. The notice line always stays.
 */
export const projectOptionsFilter: OptionsFilter = ({ options, search }) => {
  const query = foldDiacritics(search.trim());
  const contains = (text: string) => foldDiacritics(text).includes(query);
  const keep = (item: ComboboxItem): (ComboboxItem & { milestones?: readonly string[] }) | null => {
    const { search: names = item.label, milestones, notice } = item as Partial<ProjectPickerItem>;
    if (notice) return item;
    const found = milestones?.filter(contains);
    if (found === undefined) return contains(names) ? item : null;
    return contains(names) || found.length > 0 ? { ...item, milestones: found } : null;
  };
  return options.flatMap((option: ComboboxParsedItem): ComboboxParsedItem[] => {
    if ("group" in option) {
      const items = option.items.flatMap((item) => keep(item) ?? []);
      return items.length > 0 ? [{ ...option, items }] : [];
    }
    const kept = keep(option);
    return kept === null ? [] : [kept];
  });
};
