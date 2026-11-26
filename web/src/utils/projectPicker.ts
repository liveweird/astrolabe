import type { ComboboxItem, ComboboxItemGroup, ComboboxParsedItem, OptionsFilter } from "@mantine/core";
import type { PlanView } from "../api/plan";
import { openFirstByName } from "./planNames";
import { byNameThenId, foldDiacritics } from "./text";

/** A project option: `search` is every name that may find it (project, program, work stream, owner), matched with the diacritics folded. */
export type ProjectPickerItem = ComboboxItem & { search: string };

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

const matches = (item: ComboboxItem, query: string) => foldDiacritics((item as Partial<ProjectPickerItem>).search ?? item.label).includes(query);

/**
 * The picker's own `filter`: the theme's accent-insensitive "contains" (`foldedOptionsFilter`, same grouped-options contract: a group keeps the
 * items that match and disappears when none does), but over everything that names the project, so typing an owner or a program finds its projects.
 */
export const projectOptionsFilter: OptionsFilter = ({ options, search }) => {
  const query = foldDiacritics(search.trim());
  const keep = (option: ComboboxParsedItem): ComboboxParsedItem | null => {
    if ("group" in option) {
      const items = option.items.filter((item) => matches(item, query));
      return items.length > 0 ? { ...option, items } : null;
    }
    return matches(option, query) ? option : null;
  };
  return options.flatMap((option) => keep(option) ?? []);
};
