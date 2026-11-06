import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listMilestones } from "../api/milestones";
import SearchPicker, { type PickedOption } from "./SearchPicker";

/**
 * A searchable, clearable picker over EVERY project's milestones (`GET /milestones` is open to every signed-in user): the
 * dependency editor's predecessor. A milestone name recurs across projects ("Discovery"), so an option reads "name · project".
 * The caller holds the pick (its label survives later searches).
 */
export default function MilestoneSelect({
  picked,
  onPick,
  error,
  label,
  description,
}: {
  picked: PickedOption | null;
  onPick: (picked: PickedOption | null) => void;
  /** A field error (a validation the form maps onto this control). */
  error?: ReactNode;
  /** Another field label / hint than the dependency editor's "Predecessor" (the Jira bind dialog's "Project"). */
  label?: string;
  description?: string;
}) {
  const { t } = useTranslation();
  return (
    <SearchPicker
      label={label ?? t("project.dependency.predecessor")}
      description={description ?? t("project.dependency.predecessorHint")}
      placeholder={t("project.dependency.pickMilestone")}
      clearLabel={t("project.dependency.clearMilestone")}
      noMatchLabel={t("project.dependency.noMatchingMilestones")}
      queryKey={["plan", "milestones", "picker"]}
      search={async (term) => {
        const page = await listMilestones({ page: 1, pageSize: 50, sort: "name", name: term || undefined });
        return page.items.map((milestone) => ({ value: String(milestone.id), label: `${milestone.name} · ${milestone.projectName}` }));
      }}
      picked={picked}
      onPick={onPick}
      error={error}
    />
  );
}
