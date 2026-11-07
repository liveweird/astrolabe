import { Button } from "@mantine/core";
import { useTranslation } from "react-i18next";

/**
 * The "Jira dates" toggle of the timelines' `toolbar` slot (1.3): a button (`aria-pressed`, filled while on) like the Critical-path toggle, switching
 * the Jira shadow bar of every row. The page owns the choice (`useJiraBarsPick`, remembered in the browser, on by default).
 */
export default function JiraBarsToggle({ shown, onChange }: { shown: boolean; onChange: (next: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Button size="compact-sm" variant={shown ? "filled" : "default"} aria-pressed={shown} onClick={() => onChange(!shown)}>
      {t("timeline.jiraToggle")}
    </Button>
  );
}
