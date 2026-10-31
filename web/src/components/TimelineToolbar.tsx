import { Button, Group, SegmentedControl } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { ZOOMS, type Zoom } from "../utils/timelineScale";

/** The Timeline's controls: the zoom (week / month / quarter) and "Today", which scrolls today into the middle of the track. */
export default function TimelineToolbar({
  zoom,
  onZoomChange,
  onToday,
  todayDisabled,
}: {
  zoom: Zoom;
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
        data={ZOOMS.map((value) => ({ value, label: t(`timeline.zoom.${value}`) }))}
      />
      <Button size="compact-sm" variant="default" onClick={onToday} disabled={todayDisabled}>
        {t("timeline.today")}
      </Button>
    </Group>
  );
}
