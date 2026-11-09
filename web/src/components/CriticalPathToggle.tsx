import { Button } from "@mantine/core";
import { useTranslation } from "react-i18next";

/**
 * The "Critical path" toggle of the timelines' `toolbar` slot: a button (`aria-pressed`, filled while on) switching the page's critical-path
 * highlight. The page owns the choice (`useCriticalPathPick`, remembered in the browser, shared by the project and team pages). `describedBy` is the id of
 * the page's note about the figures (the team page's), referenced only while the highlight is on, i.e. while the note is on the page.
 */
export default function CriticalPathToggle({ shown, onChange, describedBy }: { shown: boolean; onChange: (next: boolean) => void; describedBy?: string }) {
  const { t } = useTranslation();
  return (
    <Button size="compact-sm" variant={shown ? "filled" : "default"} aria-pressed={shown} aria-describedby={shown ? describedBy : undefined} onClick={() => onChange(!shown)}>
      {t("timeline.criticalToggle")}
    </Button>
  );
}
