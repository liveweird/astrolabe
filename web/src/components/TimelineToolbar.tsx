import { Button, Group, SegmentedControl } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { Zoom } from "../utils/timelineScale";

/** The Timeline's controls: the zoom (the page's `zooms`) and "Today", which scrolls today into the middle of the track. */
export default function TimelineToolbar({
  zoom,
  zooms,
  onZoomChange,
  onToday,
  todayDisabled,
}: {
  zoom: Zoom;
  /** The zooms this page offers, in the order shown (`MILESTONE_ZOOMS` or `PLAN_ZOOMS`). */
  zooms: readonly Zoom[];
  onZoomChange: (zoom: Zoom) => void;
  onToday: () => void;
  /** Today lies outside the range shown, so there is nothing to scroll to. */
  todayDisabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Group gap="sm" role="group" aria-label={t("timeline.toolbarAria")}>
      <SegmentedControl
        size="xs"
        aria-label={t("timeline.zoomAria")}
        value={zoom}
        onChange={(value) => onZoomChange(value as Zoom)}
        data={zooms.map((value) => ({ value, label: t(`timeline.zoom.${value}`) }))}
      />
      <Button size="compact-sm" variant="default" onClick={onToday} disabled={todayDisabled}>
        {t("timeline.today")}
      </Button>
    </Group>
  );
}
