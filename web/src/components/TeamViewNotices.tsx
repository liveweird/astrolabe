import { useTranslation } from "react-i18next";
import { Alert, VisuallyHidden } from "@mantine/core";
import type { useProposalLock } from "../hooks/useProposalLock";
import type { useScheduleProposal } from "../hooks/useScheduleProposal";
import type { useTeamOrder } from "../hooks/useTeamOrder";
import type { useTeamSchedule } from "../hooks/useTeamSchedule";
import FormErrorAlert from "./FormErrorAlert";

type NoticeSources = {
  schedule: ReturnType<typeof useTeamSchedule>;
  order: ReturnType<typeof useTeamOrder>;
  proposal: ReturnType<typeof useScheduleProposal>;
  lock: ReturnType<typeof useProposalLock>;
};

/**
 * The notices under the team page's facts: the visible-only `role="note"` alerts (the status region says each, so an Alert's implicit
 * `role="alert"` would read it twice), the inline failures of the two write paths and the page's one polite status region.
 */
export default function TeamViewNotices({ schedule, order, proposal, lock }: NoticeSources) {
  const { t } = useTranslation();
  return (
    <>
      {(schedule.refused || order.refused || proposal.refused) && (
        <Alert color="orange" variant="light" role="note">
          {t("project.busy")}
        </Alert>
      )}
      {lock.refused && (
        <Alert color="orange" variant="light" role="note">
          {lock.open !== null ? t("teams.proposal.readOnly") : t("project.busy")}
        </Alert>
      )}
      {schedule.gone && (
        <Alert color="orange" variant="light" role="note">
          {t("project.milestoneGone")}
        </Alert>
      )}
      {order.stale && (
        <Alert color="orange" variant="light" role="note">
          {t("teams.view.orderStale")}
        </Alert>
      )}
      {schedule.stale && <FormErrorAlert>{t("project.stale")}</FormErrorAlert>}
      {schedule.error && <FormErrorAlert>{schedule.error}</FormErrorAlert>}
      {order.error && <FormErrorAlert>{order.error}</FormErrorAlert>}
      {/* Button- and dialog-driven changes (schedule, order) are announced here (a drag is announced by dnd-kit's own live region). */}
      <VisuallyHidden role="status" aria-live="polite">
        {schedule.announcement}
      </VisuallyHidden>
    </>
  );
}
