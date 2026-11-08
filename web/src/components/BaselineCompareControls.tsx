import { Select, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useBaselines } from "../hooks/useBaselines";

/** The "live plan" option's value (a baseline's value is its id in digits, which this can never be). */
const LIVE = "live";

/**
 * The comparison page's "Compare against" picker (1.7): the page's baseline is always "then"; this chooses "now" - the live plan (the default, the
 * pre-1.7 comparison) or any OTHER baseline, newest first with its plan revision. The choice is the page's (the URL's `against` parameter, so a
 * comparison is a link); `dropped` says the remembered baseline was deleted meanwhile and the page fell back to the live plan. A baseline the list
 * does not hold yet (it is loading, or was just deleted) stays an option of its own, so the field never shows a value that is not among the options.
 * Reads only; a list that could not be loaded leaves the live plan as the one choice.
 */
export default function BaselineCompareControls({
  id,
  against,
  onChange,
  dropped,
}: {
  /** The page's own baseline (not offered: a baseline cannot be compared with itself). */
  id: number;
  against: number | null;
  onChange: (against: number | null) => void;
  dropped: boolean;
}) {
  const { t } = useTranslation();
  const { items, failed } = useBaselines();
  const options = [
    { value: LIVE, label: t("baselines.compare.against.live") },
    ...items.filter((baseline) => baseline.id !== id).map((baseline) => ({ value: String(baseline.id), label: t("baselines.compare.against.option", { name: baseline.name, revision: baseline.planRevision }) })),
  ];
  if (against !== null && !items.some((baseline) => baseline.id === against)) options.push({ value: String(against), label: t("baselines.compare.against.fallback", { id: against }) });
  return (
    <Stack gap={4} data-print="hide">
      <Select
        label={t("baselines.compare.against.label")}
        description={t("baselines.compare.against.description")}
        w={320}
        searchable
        allowDeselect={false}
        data={options}
        value={against === null ? LIVE : String(against)}
        onChange={(value) => onChange(value === null || value === LIVE ? null : Number(value))}
        disabled={failed}
      />
      {failed && (
        <Text size="xs" c="dimmed">
          {t("baselines.compare.against.unavailable")}
        </Text>
      )}
      {dropped && (
        <Text size="sm" c="dimmed" role="status">
          {t("baselines.compare.against.dropped")}
        </Text>
      )}
    </Stack>
  );
}
