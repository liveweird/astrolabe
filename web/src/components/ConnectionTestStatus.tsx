import { Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { JiraTestResult } from "../api/jira";

/**
 * The polite status region that SAYS what a Test connection came to ("Test passed. OK: 8 of 8."), so a screen reader hears the verdict
 * when the result table appears under it. The region is always mounted (a live region announces changes to what it already holds); it is
 * empty while no result is shown. A test passes when no REQUIRED probe failed; failed optional probes are counted on top.
 */
export default function ConnectionTestStatus({ result }: { result: JiraTestResult | null }) {
  const { t } = useTranslation();
  let text: string | null = null;
  if (result) {
    const total = result.rows.length;
    const ok = result.rows.filter((row) => row.ok).length;
    const failedRequired = result.rows.filter((row) => !row.ok && row.required).length;
    const failedOptional = result.rows.filter((row) => !row.ok && !row.required).length;
    if (failedRequired > 0) text = t("jira.test.summaryFailed", { failed: failedRequired, total });
    else if (failedOptional > 0) text = t("jira.test.summaryPassedOptional", { ok, total, optional: failedOptional });
    else text = t("jira.test.summaryPassed", { ok, total });
  }
  return (
    <div role="status" aria-live="polite">
      {text && <Text size="sm">{text}</Text>}
    </div>
  );
}
