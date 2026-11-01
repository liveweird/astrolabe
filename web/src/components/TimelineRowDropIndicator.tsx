import { useTimelinePreview } from "../hooks/useTimelinePreview";
import { ROW_HEIGHT } from "../utils/timelineModel";
import classes from "../theme.module.css";

/**
 * The insertion line of a row drag: a 2 px rule across the body at the slot the held row would land in. It reads the preview ITSELF, so a
 * bar drag (whose preview it ignores) never re-renders the Timeline — only the bars and this line subscribe. It sits BELOW the sticky header
 * (see the CSS), so a slot scrolled up under the header is simply covered by it; the first slot's line starts at the body's edge.
 */
export default function TimelineRowDropIndicator({ width }: { width: number }) {
  const preview = useTimelinePreview();
  if (preview === null || preview.kind !== "row" || preview.slot === null) return null;
  return <div aria-hidden="true" data-row-slot={preview.slot} className={classes.timelineRowDropLine} style={{ top: Math.max(preview.slot * ROW_HEIGHT - 1, 0), width }} />;
}
