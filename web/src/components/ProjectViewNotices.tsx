import { useTranslation } from "react-i18next";
import { Alert, VisuallyHidden } from "@mantine/core";
import type { useMilestoneSchedule } from "../hooks/useMilestoneSchedule";
import FormErrorAlert from "./FormErrorAlert";

/**
 * The notices under the project page's facts: the visible-only `role="note"` alerts (the status region says each, so an Alert's
 * implicit `role="alert"` would read it twice), the inline failures of the schedule write path and the page's one polite status region
 * (button- and dialog-driven changes are announced there; a drag is announced by dnd-kit's own live region).
 */
export default function ProjectViewNotices({ schedule }: { schedule: ReturnType<typeof useMilestoneSchedule> }) {
  const { t } = useTranslation();
  return (
    <>
      {schedule.refused && (
        <Alert color="orange" variant="light" role="note">
          {t("project.busy")}
        </Alert>
      )}
      {schedule.gone && (
        <Alert color="orange" variant="light" role="note">
          {t("project.milestoneGone")}
        </Alert>
      )}
      {schedule.stale && <FormErrorAlert>{t("project.stale")}</FormErrorAlert>}
      {schedule.error && <FormErrorAlert>{schedule.error}</FormErrorAlert>}
      <VisuallyHidden role="status" aria-live="polite">
        {schedule.announcement}
      </VisuallyHidden>
    </>
  );
}
