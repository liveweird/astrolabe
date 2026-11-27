import { Alert, VisuallyHidden } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useLiveText } from "../hooks/useLiveText";
import { useSavedVerdict } from "../hooks/useSavedVerdict";

/**
 * The Roadmap overview with no work streams has no tree to open a saved proposal on, but an address that names one which does not open (`?proposal=`, gone or unreadable) still
 * says so and drops the parameter (`useSavedVerdict`, the run's own reading). The visible Alert is a plain note like the tree's own (its implicit `role="alert"` would read twice); the
 * polite status region (`useLiveText`) announces it, since nothing else on this page would.
 */
export default function EmptyPlanSavedNotice() {
  const { t } = useTranslation();
  const { notice, dismissNotice } = useSavedVerdict(() => undefined);
  const said = useLiveText(notice === null ? "" : notice.text);
  return (
    <>
      <VisuallyHidden role="status" aria-live="polite">
        {said}
      </VisuallyHidden>
      {notice !== null && (
        <Alert color="orange" variant="light" role="note" withCloseButton closeButtonLabel={t("common.action.dismissNotice")} onClose={dismissNotice}>
          {notice.text}
        </Alert>
      )}
    </>
  );
}
