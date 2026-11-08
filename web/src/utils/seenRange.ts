/** The earliest and latest day a timeline page has shown (ISO dates). */
export type SeenRange = { min: string; max: string };

/**
 * The range a timeline page remembers only ever grows, so a drag never shifts the bars under the pointer: `seen` widened to cover
 * `dates`, or `null` when `seen` already covers them all (nothing to store) or there is no date to cover.
 */
export function growSeenRange(seen: SeenRange | null, dates: string[]): SeenRange | null {
  if (dates.length === 0) return null;
  const min = dates.reduce((a, b) => (b < a ? b : a));
  const max = dates.reduce((a, b) => (b > a ? b : a));
  if (seen !== null && min >= seen.min && max <= seen.max) return null;
  return { min: seen !== null && seen.min < min ? seen.min : min, max: seen !== null && seen.max > max ? seen.max : max };
}
