import { VisuallyHidden } from "@mantine/core";
import { useTranslation } from "react-i18next";

/**
 * The Slack column's cell (v0.7, present only while the toggle is on): "0" plus a visually hidden "critical path" for a zero-slack entity,
 * else its working days; "" when an own milestone has no slack (unscheduled rows never get here), "—" for a ghost row the server's
 * upstream list does not name (downstream-only or unconnected).
 */
export default function SlackCell({ slackDays, critical, absent }: { slackDays: number | null; critical: boolean; absent?: boolean }) {
  const { t } = useTranslation();
  if (absent === true) {
    return (
      <span>
        <span aria-hidden="true">{t("project.critical.slackNone")}</span>
        <VisuallyHidden component="span">{t("project.critical.notUpstream")}</VisuallyHidden>
      </span>
    );
  }
  if (slackDays === null) return null;
  if (!critical) return <span>{t("project.critical.slackDays", { count: slackDays })}</span>;
  return (
    <span>
      {slackDays}
      <VisuallyHidden component="span"> {t("project.critical.slackCritical")}</VisuallyHidden>
    </span>
  );
}
