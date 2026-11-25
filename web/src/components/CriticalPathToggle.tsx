import { Button } from "@mantine/core";
import { useTranslation } from "react-i18next";

/**
 * The "Critical path" toggle of the timelines' `toolbar` slot: a button (`aria-pressed`, filled while on) switching the page's critical-path
 * highlight. The page owns the choice (`useCriticalPathPick`, remembered in the browser, shared by the project and team pages). `describedBy` is the id of
 * the page's note about the figures (the team page's), referenced only while the highlight is on, i.e. while the note is on the page. `disabled` (the team
 * page, 1.27: the toggle selects the cached view entry the writes target) is set while a write runs or a proposal is requested or open, as the baseline picker is.
 */
export default function CriticalPathToggle({ shown, onChange, describedBy, disabled = false }: { shown: boolean; onChange: (next: boolean) => void; describedBy?: string; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <Button size="compact-sm" variant={shown ? "filled" : "default"} aria-pressed={shown} aria-describedby={shown ? describedBy : undefined} disabled={disabled} onClick={() => onChange(!shown)}>
      {t("timeline.criticalToggle")}
    </Button>
  );
}
