import { Alert } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { useScheduleProposal } from "../hooks/useScheduleProposal";
import { outcomeSentence } from "../utils/scheduleProposal";
import FormErrorAlert from "./FormErrorAlert";

type Proposal = ReturnType<typeof useScheduleProposal>;

/**
 * What the proposal flow says outside the section, as dismissible notes that last until the next action: a proposal that opened nothing
 * ("nothing to propose" gray, "no capacity: add a capacity period first" orange), what an accept came to (green; orange when something
 * was skipped, with the server's reasons), the whole-batch stale notice and the re-proposed-after-a-scope-change notice (orange), and the inline failure of a propose or an accept.
 * Visible only (`role="note"`): the page's status region says each, so an Alert's implicit `role="alert"` would read it twice.
 */
export default function ProposalNotes({ proposal }: { proposal: Proposal }) {
  const { t } = useTranslation();
  const { note, outcome, stale, rescoped } = proposal;
  const open = proposal.proposal;
  const dismissible = { variant: "light", role: "note", withCloseButton: true, closeButtonLabel: t("common.action.close"), onClose: proposal.dismiss } as const;
  return (
    <>
      {note !== null && (
        <Alert color={note === "noCapacity" ? "orange" : "gray"} {...dismissible}>
          {note === "noCapacity" ? t("teams.proposal.noCapacity", { date: proposal.noteDate }) : t("teams.proposal.nothing")}
        </Alert>
      )}
      {outcome !== null && (
        <Alert color={outcome.skipped.length > 0 ? "orange" : "green"} {...dismissible}>
          {outcomeSentence(outcome, t)}
        </Alert>
      )}
      {stale && (
        <Alert color="orange" {...dismissible}>
          {t("teams.proposal.stale")}
        </Alert>
      )}
      {rescoped && (
        <Alert color="orange" {...dismissible}>
          {t("teams.proposal.rescoped")}
        </Alert>
      )}
      {/* An accept's failure sits inside the open section; this is a propose's, shown while no preview is open. */}
      {open === null && proposal.error && <FormErrorAlert>{proposal.error}</FormErrorAlert>}
    </>
  );
}
