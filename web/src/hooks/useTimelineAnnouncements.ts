import { useMemo, type MutableRefObject } from "react";
import type { Announcements } from "@dnd-kit/core";
import type { TFunction } from "i18next";
import { dragDataOf, type DragData } from "./useTimelinePreview";
import { isRowNoop, type Span } from "../utils/timelineDrag";
import { rowFacts, spanOf } from "../utils/timelineDragTracking";

/** The latest outcome of the running drag, written by `TimelineDndContext`'s handlers and read by the announcements (dnd-kit calls the handlers BEFORE them). */
export type LatestDrag = { drag: DragData; span: Span | null; slot?: number | null; refused?: boolean };

/**
 * The announcements of the ONE `DndContext` of a Timeline page, in the UI language: every step of a move, resize, tray, row or draw gesture, said once
 * per distinct outcome (`announced` remembers the last one), and a finished or cancelled drag announced once and forgotten (`latest` is taken). The
 * context's handlers run before dnd-kit asks for these, so a refusal they record in `latest` is said as "not changed". The two refs are created by the
 * context, whose handlers keep them up to date.
 */
export function useTimelineAnnouncements(t: TFunction, latestRef: MutableRefObject<LatestDrag | null>, announcedRef: MutableRefObject<string | null>) {
  return useMemo<Announcements>(() => {
    const take = () => {
      const current = latestRef.current;
      latestRef.current = null;
      return current;
    };
    const names = (drag: DragData, span: Span | null) => ({ name: drag.label, start: span?.start, end: span?.end });
    const startKey = {
      move: "timeline.announce.startMove",
      "resize-start": "timeline.announce.startResizeStart",
      "resize-end": "timeline.announce.startResizeEnd",
      tray: "timeline.announce.startTray",
      row: "timeline.announce.startRow",
      draw: "timeline.announce.startDraw",
    } as const;
    return {
      onDragStart: ({ active }) => {
        const drag = dragDataOf(active);
        if (drag === null) return undefined;
        return drag.kind === "row" ? t(startKey.row, rowFacts(drag, null)) : t(startKey[drag.kind], names(drag, spanOf(drag)));
      },
      onDragMove: () => {
        const current = latestRef.current;
        if (current === null) return undefined;
        if (current.drag.kind === "row") {
          // once per distinct slot; nowhere to land says nothing (the drop will)
          if (current.slot === undefined || current.slot === null) return undefined;
          const key = `slot:${current.slot}`;
          if (announcedRef.current === key) return undefined;
          announcedRef.current = key;
          return t("timeline.announce.stepRow", rowFacts(current.drag, current.slot));
        }
        if (current.span === null || current.drag.kind === "tray") return undefined;
        const key = `${current.span.start}/${current.span.end}`;
        if (announcedRef.current === key) return undefined;
        announcedRef.current = key;
        return t("timeline.announce.step", names(current.drag, current.span));
      },
      onDragOver: () => undefined,
      // A finished or cancelled drag is announced once and forgotten (the announcement runs after the handlers above).
      onDragEnd: () => {
        const current = take();
        if (current === null) return undefined;
        if (current.refused) return t("timeline.announce.dropRefused", { name: current.drag.label });
        if (current.drag.kind === "row") {
          const slot = current.slot ?? null;
          const stays = slot === null || (current.drag.position !== undefined && isRowNoop(current.drag.position - 1, slot));
          return stays ? t("timeline.announce.dropRowNone", rowFacts(current.drag, null)) : t("timeline.announce.dropRow", rowFacts(current.drag, slot));
        }
        if (current.drag.kind === "draw") {
          return current.span === null ? t("timeline.announce.cancelDraw", { name: current.drag.label }) : t("timeline.announce.dropDraw", names(current.drag, current.span));
        }
        if (current.drag.kind === "tray") {
          return current.span === null
            ? t("timeline.announce.dropNone", { name: current.drag.label })
            : t("timeline.announce.dropTray", names(current.drag, current.span));
        }
        return t("timeline.announce.drop", names(current.drag, current.span ?? spanOf(current.drag)));
      },
      onDragCancel: () => {
        const current = take();
        if (current === null) return undefined;
        if (current.drag.kind === "row") return t("timeline.announce.cancelRow", rowFacts(current.drag, null));
        if (current.drag.kind === "draw") return t("timeline.announce.cancelDraw", { name: current.drag.label });
        return current.drag.kind === "tray"
          ? t("timeline.announce.cancelTray", { name: current.drag.label })
          : t("timeline.announce.cancel", names(current.drag, spanOf(current.drag)));
      },
    };
  }, [t, latestRef, announcedRef]);
}
