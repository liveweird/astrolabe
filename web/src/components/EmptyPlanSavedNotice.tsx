import { Alert } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useSavedVerdict } from "../hooks/useSavedVerdict";

/**
 * The Roadmap overview with no work streams has no tree to open a saved proposal on, but an address that names one which does not open (`?proposal=`, gone or unreadable) still
 * says so and drops the parameter (`useSavedVerdict`, the run's own reading). The note is a polite status: nothing else on this page would announce it.
 */
export default function EmptyPlanSavedNotice() {
  const { t } = useTranslation();
  const { notice, dismissNotice } = useSavedVerdict(() => undefined);
  if (notice === null) return null;
  return (
    <Alert color="orange" variant="light" role="status" withCloseButton closeButtonLabel={t("common.action.dismissNotice")} onClose={dismissNotice}>
      {notice.text}
    </Alert>
  );
}
