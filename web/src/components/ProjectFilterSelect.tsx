import { useTranslation } from "react-i18next";
import { Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { getPlanView, planViewKey } from "../api/plan";
import { projectOptions } from "../utils/planNames";

/**
 * The Project select of the list pages' filter panels (Milestones, Dependencies): every project of the plan view (the chip's and the Plan page's
 * cache entry, read when the panel is open - its fields mount only then), searchable and clearable, `undefined` = any. Two projects of one name are
 * told apart by their program. A `projectId` the settled plan does not hold is one more option, "Project 12" (the chip's own words); while the plan
 * has not answered or failed there is no such option.
 */
export default function ProjectFilterSelect({ projectId, onChange }: { projectId: number | undefined; onChange: (projectId: number | undefined) => void }) {
  const { t } = useTranslation();
  const plan = useQuery({ queryKey: planViewKey, queryFn: getPlanView });
  const data = projectOptions(plan.data).map((option) => ({ value: String(option.id), label: option.label }));
  if (projectId !== undefined && plan.data !== undefined && !data.some((option) => option.value === String(projectId))) {
    data.push({ value: String(projectId), label: t("deviations.filter.projectUnknown", { id: projectId }) });
  }
  return (
    <Select
      label={t("common.filter.project")}
      placeholder={t("common.state.any")}
      data={data}
      value={projectId === undefined ? null : String(projectId)}
      onChange={(selected) => onChange(selected === null ? undefined : Number(selected))}
      searchable
      clearable
      clearButtonProps={{ "aria-label": t("common.filter.clearProject") }}
    />
  );
}
