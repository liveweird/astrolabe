import { useTranslation } from "react-i18next";
import type { MovementTotals } from "../api/baselines";
import { rankTotalsParts, type RankTotals } from "../utils/baselineOverlay";
import { TotalsBadges } from "./BaselineParts";

/**
 * The plan pages' one totals line (v0.9, under the toolbar): "vs baseline Q1 commitment:" then the non-zero counts of projects by what became of
 * them, as the comparison page's badges (ORANGE for the projects whose end is later). The roadmap also passes `ranks` (1.7): "N moved up in rank,
 * M down" join the same line when any rank moved; the programs page has no rank column and passes none. A note for assistive technology, nothing interactive.
 */
export default function BaselineTotals({ name, totals, ranks }: { name: string; totals: MovementTotals; ranks?: RankTotals }) {
  const { t } = useTranslation();
  return <TotalsBadges role="note" label={t("timeline.baseline.totals", { name })} totals={totals} extra={ranks === undefined ? undefined : rankTotalsParts(ranks, t)} />;
}
