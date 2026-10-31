import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useTranslation } from "react-i18next";
import { useTimelinePreview, type DragData } from "../hooks/useTimelinePreview";
import type { DragKind } from "../utils/timelineDrag";
import type { RovingTarget, TimelineBarData } from "../utils/timelineModel";
import { toEpochDay, type TimelineScale } from "../utils/timelineScale";
import classes from "../theme.module.css";

/**
 * The edge handles' width, a CONSTANT per zoom (never derived from the live bar width: a resize must not re-measure the node
 * being dragged). The handles sit OUTSIDE the bar, so even a 1-day bar at quarter zoom keeps its whole 3 px body as the move target.
 */
const handleWidthFor = (dayWidth: number) => (dayWidth >= 8 ? 6 : 4);

/** The bar's roving stops: `roving(0)` the bar, `roving(1)`/`roving(2)` its start/end handles. */
type BarRoving = (offset: 0 | 1 | 2) => RovingTarget;

/**
 * One bar. Editable bars are three dnd-kit draggables that are SIBLINGS (no button inside a button): the body moves the bar
 * (translated in place, snapped to days by the context's modifiers) and the two edge handles resize it (the bar redraws from the
 * context's preview dates). Read-only bars are a labelled image with no handles. Every one is a stop of the roving grid; the
 * focus ring is the theme's. Space or Enter picks an editable bar or handle up (dnd-kit's KeyboardSensor).
 */
export default function TimelineBar({ bar, scale, roving }: { bar: TimelineBarData; scale: TimelineScale; roving: BarRoving }) {
  const preview = useTimelinePreview();
  // A resize redraws the bar from the preview; a move keeps its geometry and is translated (see EditableBar).
  const shown = preview !== null && preview.barId === bar.id && preview.kind !== "move" ? preview : bar;
  const start = toEpochDay(shown.start);
  const geometry = { left: scale.xOf(start), width: scale.widthOf(start, toEpochDay(shown.end)) };
  return bar.editable ? (
    <EditableBar bar={bar} geometry={geometry} handleWidth={handleWidthFor(scale.dayWidth)} roving={roving} />
  ) : (
    <ReadOnlyBar bar={bar} geometry={geometry} roving={roving} />
  );
}

interface BarProps {
  bar: TimelineBarData;
  geometry: { left: number; width: number };
  roving: BarRoving;
}

function ReadOnlyBar({ bar, geometry, roving }: BarProps) {
  const { t } = useTranslation();
  return (
    <div className={classes.timelineBar} style={geometry}>
      <div role="img" aria-label={t("timeline.bar.readOnly", { label: bar.describe })} className={classes.timelineBarBody} {...roving(0)} />
    </div>
  );
}

function EditableBar({ bar, geometry, handleWidth, roving }: BarProps & { handleWidth: number }) {
  const { t } = useTranslation();
  const data = (kind: DragKind): DragData => ({ kind, barId: bar.id, label: bar.label, start: bar.start, end: bar.end });
  const id = (kind: DragKind) => `bar:${bar.id}:${kind}`;
  const handleRole = t("timeline.bar.handleRoleDescription");
  // Destructured (like RoadmapRow's useSortable): the hook's result carries a ref the compiler lint will not let us read as a field.
  const { setNodeRef: bodyRef, attributes: bodyAttrs, listeners: bodyListeners, transform, isDragging: bodyDragging } = useDraggable({
    id: id("move"),
    data: data("move"),
    attributes: { roleDescription: t("timeline.bar.roleDescription") },
  });
  const { setNodeRef: startRef, attributes: startAttrs, listeners: startListeners, isDragging: startDragging } = useDraggable({
    id: id("resize-start"),
    data: data("resize-start"),
    attributes: { roleDescription: handleRole },
  });
  const { setNodeRef: endRef, attributes: endAttrs, listeners: endListeners, isDragging: endDragging } = useDraggable({
    id: id("resize-end"),
    data: data("resize-end"),
    attributes: { roleDescription: handleRole },
  });
  const dragging = bodyDragging || startDragging || endDragging;

  return (
    <div className={classes.timelineBar} style={{ ...geometry, transform: CSS.Translate.toString(transform) }}>
      <div
        ref={bodyRef}
        aria-label={bar.describe}
        className={`${classes.timelineBarBody} ${classes.timelineBarEditable} ${dragging ? classes.timelineBarDragging : ""}`}
        {...bodyAttrs}
        {...bodyListeners}
        {...roving(0)}
      />
      <div
        ref={startRef}
        aria-label={t("timeline.bar.startHandleAria", { name: bar.label })}
        className={classes.timelineHandle}
        style={{ left: -handleWidth, width: handleWidth }}
        {...startAttrs}
        {...startListeners}
        {...roving(1)}
      />
      <div
        ref={endRef}
        aria-label={t("timeline.bar.endHandleAria", { name: bar.label })}
        className={classes.timelineHandle}
        style={{ right: -handleWidth, width: handleWidth }}
        {...endAttrs}
        {...endListeners}
        {...roving(2)}
      />
    </div>
  );
}
