import { Button } from "@mantine/core";
import { useTranslation } from "react-i18next";

/**
 * The "Critical path" toggle of the timelines' `toolbar` slot: a button (`aria-pressed`, filled while on) switching the page's critical-path
 * highlight. The page owns the choice (`useCriticalPathPick`, remembered in the browser, shared by the project and team pages).
 */
export default function CriticalPathToggle({ shown, onChange }: { shown: boolean; onChange: (next: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Button size="compact-sm" variant={shown ? "filled" : "default"} aria-pressed={shown} onClick={() => onChange(!shown)}>
      {t("timeline.criticalToggle")}
    </Button>
  );
}
