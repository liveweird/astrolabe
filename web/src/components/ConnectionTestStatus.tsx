import { Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { isSkipped, type TestRow } from "../utils/connectionTestRows";

/**
 * The polite status region that SAYS what a Test connection came to ("Test passed. OK: 8 of 8."), so a screen reader hears the verdict
 * when the result table appears under it. The region is always mounted (a live region announces changes to what it already holds); it is
 * empty while no result is shown. A test passes when no REQUIRED probe failed; failed optional probes are counted on top.
 */
export default function ConnectionTestStatus<R extends { rows: readonly TestRow[] }>({ result }: { result: R | null }) {
  const { t } = useTranslation();
  let text: string | null = null;
  if (result) {
    const total = result.rows.length;
    const ok = result.rows.filter((row) => row.ok).length;
    // A skipped row did not run: it is no failure of its own (the failed `tenant_info` above it is the one counted).
    const failedRequired = result.rows.filter((row) => !row.ok && row.required && !isSkipped(row)).length;
    const failedOptional = result.rows.filter((row) => !row.ok && !row.required && !isSkipped(row)).length;
    // Defensive: whatever the codes say, a required row that is not ok never reads as a pass (a skipped-only payload counts its skips).
    const notOkRequired = result.rows.filter((row) => !row.ok && row.required).length;
    if (notOkRequired > 0) text = t("sync.test.summaryFailed", { failed: failedRequired || notOkRequired, total });
    else if (failedOptional > 0) text = t("sync.test.summaryPassedOptional", { ok, total, optional: failedOptional });
    else text = t("sync.test.summaryPassed", { ok, total });
  }
  return (
    <div role="status" aria-live="polite">
      {text && <Text size="sm">{text}</Text>}
    </div>
  );
}
