import { Alert, VisuallyHidden } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useLiveText } from "../hooks/useLiveText";

/**
 * The project page's notice for a milestone address (`?milestone=`) that names no milestone of this project (removed, moved to another project, a malformed id):
 * no error page, the page works as ever. Always mounted: the polite status region exists empty and is FILLED when `gone` (`useLiveText`), so a screen reader
 * announces it; the visible Alert is a plain note (its implicit `role="alert"` would read it twice), dismissible.
 */
export default function MilestoneArrivalNotice({ gone, onClose }: { gone: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const text = t("project.milestoneArrival.gone");
  const said = useLiveText(gone ? text : "");
  return (
    <>
      <VisuallyHidden role="status" aria-live="polite">
        {said}
      </VisuallyHidden>
      {gone && (
        <Alert color="orange" variant="light" role="note" withCloseButton closeButtonLabel={t("common.action.dismissNotice")} onClose={onClose}>
          {text}
        </Alert>
      )}
    </>
  );
}
