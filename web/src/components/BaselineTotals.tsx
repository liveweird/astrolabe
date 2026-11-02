import { useTranslation } from "react-i18next";
import type { MovementTotals } from "../api/baselines";
import { TotalsBadges } from "./BaselineParts";

/**
 * The plan pages' one totals line (v0.9, under the toolbar): "vs baseline Q1 commitment:" then the non-zero counts of projects by what became of
 * them, as the comparison page's badges (ORANGE for the projects whose end is later). A note for assistive technology, nothing interactive.
 */
export default function BaselineTotals({ name, totals }: { name: string; totals: MovementTotals }) {
  const { t } = useTranslation();
  return <TotalsBadges role="note" label={t("timeline.baseline.totals", { name })} totals={totals} />;
}
