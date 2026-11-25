import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listMilestones } from "../api/milestones";
import { OPTION_PAGE_SIZE } from "../hooks/usePagedSort";
import SearchPicker, { type PickedOption } from "./SearchPicker";

/**
 * A searchable, clearable picker over EVERY project's milestones (`GET /milestones` is open to every signed-in user): the
 * dependency editor's predecessor. A milestone name recurs across projects ("Discovery"), so an option reads "name · project".
 * With `projectId` (the Dependencies page's add dialog, 1.27: the successor) it lists only that project's milestones, in a query of its own.
 * The caller holds the pick (its label survives later searches).
 */
export default function MilestoneSelect({
  picked,
  onPick,
  error,
  label,
  description,
  clearLabel,
  projectId,
  dataAutofocus,
}: {
  picked: PickedOption | null;
  onPick: (picked: PickedOption | null) => void;
  /** A field error (a validation the form maps onto this control). */
  error?: ReactNode;
  /** Another field label / hint than the dependency editor's "Predecessor" (the Jira bind dialog's "Project"). */
  label?: string;
  description?: string;
  /** Another clear-button name than "Clear the predecessor milestone". */
  clearLabel?: string;
  /** Only this project's milestones (`GET /milestones?projectId=`); absent = every project's. */
  projectId?: number;
  /** The control a dialog's focus trap lands on when it opens. */
  dataAutofocus?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <SearchPicker
      label={label ?? t("project.dependency.predecessor")}
      description={description ?? t("project.dependency.predecessorHint")}
      placeholder={t("project.dependency.pickMilestone")}
      clearLabel={clearLabel ?? t("project.dependency.clearMilestone")}
      noMatchLabel={t("project.dependency.noMatchingMilestones")}
      queryKey={projectId === undefined ? ["plan", "milestones", "picker"] : ["plan", "milestones", "picker", projectId]}
      search={async (term) => {
        const page = await listMilestones({ page: 1, pageSize: OPTION_PAGE_SIZE, sort: "name", name: term || undefined, projectId });
        return page.items.map((milestone) => ({ value: String(milestone.id), label: `${milestone.name} · ${milestone.projectName}` }));
      }}
      picked={picked}
      onPick={onPick}
      error={error}
      dataAutofocus={dataAutofocus}
    />
  );
}
