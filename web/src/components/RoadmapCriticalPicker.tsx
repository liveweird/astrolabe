import { useId } from "react";
import { Group, Select, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { RoadmapView } from "../api/roadmap";
import { allProjects } from "../utils/roadmapRows";

/** The "no target" option's value (a project's value is its id in digits, which this can never be). */
const NONE = "none";

/**
 * The roadmap's "Critical path to…" picker (1.7, in the Timeline's `toolbar` slot): a labelled, searchable `Select` over "None" and the projects that
 * have a span (a project with nothing scheduled has no end to drive), by name. The picked project stays an option of its own even without a span (the
 * row menu can pick it), so the field never shows a value that is not among the options. `disabled` is the page's "a write is in flight".
 */
export default function RoadmapCriticalPicker({ view, target, onPick, disabled }: { view: RoadmapView; target: number | null; onPick: (id: number | null) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const options = allProjects(view)
    .filter((project) => project.span !== null || project.id === target)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
    .map((project) => ({ value: String(project.id), label: project.name }));
  return (
    <Group gap={6} wrap="nowrap" data-print="hide">
      <Text component="label" htmlFor={id} size="xs" fw={500}>
        {t("roadmap.critical.pickerLabel")}
      </Text>
      <Select
        id={id}
        size="xs"
        w={{ base: 160, sm: 220 }}
        searchable
        allowDeselect={false}
        data={[{ value: NONE, label: t("roadmap.critical.none") }, ...options]}
        value={target === null ? NONE : String(target)}
        onChange={(value) => onPick(value === null || value === NONE ? null : Number(value))}
        disabled={disabled}
      />
    </Group>
  );
}
