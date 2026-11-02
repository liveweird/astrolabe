import { useId } from "react";
import { Group, Select, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useBaselines } from "../hooks/useBaselines";

/** The "no baseline" option's value (a baseline's value is its id in digits, which this can never be). */
const NONE = "none";

/**
 * The timelines' baseline picker (v0.9, in the Timeline's `toolbar` slot): a labelled `Select` over "None" and the baselines newest first, the first
 * marked "(latest)". The default is no baseline; the pick is the page's (`useBaselinePick`, one browser-wide pick for every timeline page).
 * A pick the list does not hold (it is still loading, or the baseline was just deleted elsewhere) stays an option of its own, so the field never shows
 * a value that is not among the options: `current` (the baseline the loaded view compares with) names it, else it reads "Baseline <id>". When the list
 * could not be loaded the picker is disabled and says so in the muted line the Timeline uses for the holidays; `disabled` is the page's "a write
 * is in flight / a proposal is open": a pick changed then would make the write's answer land in another view entry.
 */
export default function BaselinePicker({
  pick,
  onPick,
  current,
  disabled = false,
}: {
  pick: number | null;
  onPick: (id: number | null) => void;
  current?: { id: number; name: string };
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { items, failed } = useBaselines();
  const id = useId();
  const options = [
    { value: NONE, label: t("timeline.baseline.none") },
    ...items.map((baseline, index) => ({ value: String(baseline.id), label: index === 0 ? t("timeline.baseline.latest", { name: baseline.name }) : baseline.name })),
  ];
  if (pick !== null && !items.some((baseline) => baseline.id === pick)) {
    options.push({ value: String(pick), label: current?.id === pick ? current.name : t("timeline.baseline.pickFallback", { id: pick }) });
  }
  return (
    <Group gap={6} wrap="nowrap" data-print="hide">
      <Text component="label" htmlFor={id} size="xs" fw={500}>
        {t("timeline.baseline.pickerLabel")}
      </Text>
      <Select
        id={id}
        size="xs"
        w={220}
        searchable
        allowDeselect={false}
        data={options}
        value={pick === null ? NONE : String(pick)}
        onChange={(value) => onPick(value === null || value === NONE ? null : Number(value))}
        disabled={failed || disabled}
      />
      {failed && (
        <Text size="xs" c="dimmed">
          {t("timeline.baseline.unavailable")}
        </Text>
      )}
    </Group>
  );
}
