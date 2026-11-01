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
  // (a held ROW and a DRAW have previews too — a slot, a span for the row's draw surface — which no bar draws)
  const resizing = preview !== null && (preview.kind === "resize-start" || preview.kind === "resize-end") && preview.barId === bar.id;
  const shown = resizing ? preview : bar;
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

/**
 * A bar's tone: a ghost (another project's endpoint) is faint and dashed, a summary (the project's span) hollow — both READ-ONLY tones, ignored on
 * an editable bar — and a window (a target window) the band look, honoured on a read-only AND on an editable bar (`toneOf`).
 */
const TONE_CLASS = { ghost: classes.timelineBarGhost, summary: classes.timelineBarSummary, window: classes.timelineBarWindow } as const;

/** The bar's wrapper class: a window bar fills the whole row height, any other bar sits inset in it. */
const frameClass = (bar: TimelineBarData) => (bar.tone === "window" ? `${classes.timelineBar} ${classes.timelineBarFrameWindow}` : classes.timelineBar);

/** The tone a bar is drawn with: any on a read-only bar, only `window` on an editable one. */
const toneOf = (bar: TimelineBarData) => (bar.editable && bar.tone !== "window" ? undefined : bar.tone);

const toneClass = (bar: TimelineBarData) => {
  const tone = toneOf(bar);
  return tone === undefined ? "" : TONE_CLASS[tone];
};

function ReadOnlyBar({ bar, geometry, roving }: BarProps) {
  const { t } = useTranslation();
  const tone = toneClass(bar);
  return (
    <div className={frameClass(bar)} style={geometry}>
      <div
        role="img"
        aria-label={t("timeline.bar.readOnly", { label: bar.describe })}
        className={`${classes.timelineBarBody} ${tone}`}
        data-tone={bar.tone}
        {...roving(0)}
      />
    </div>
  );
}

function EditableBar({ bar, geometry, handleWidth, roving }: BarProps & { handleWidth: number }) {
  const { t } = useTranslation();
  const data = (kind: DragKind): DragData => ({ kind, barId: bar.id, label: bar.label, start: bar.start, end: bar.end });
  const id = (kind: DragKind) => `bar:${bar.id}:${kind}`;
  const handleRole = t("timeline.bar.handleRoleDescription");
  // Destructured: the hook's result carries a ref the compiler lint will not let us read as a field.
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
    <div className={frameClass(bar)} style={{ ...geometry, transform: CSS.Translate.toString(transform) }}>
      <div
        ref={bodyRef}
        aria-label={bar.describe}
        data-tone={toneOf(bar)}
        className={`${classes.timelineBarBody} ${toneClass(bar)} ${classes.timelineBarEditable} ${dragging ? classes.timelineBarDragging : ""}`}
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
