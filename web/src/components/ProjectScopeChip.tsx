import { useTranslation } from "react-i18next";
import { Badge, CloseButton, Group } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { getPlanView, planViewKey } from "../api/plan";
import { planNames } from "../utils/planNames";

/** The project a link scopes a list page to, as a removable chip beside the filter panel's toggle (visible with the panel collapsed), named from the plan view. */
export default function ProjectScopeChip({ projectId, onRemove }: { projectId: number; onRemove: () => void }) {
  const { t } = useTranslation();
  const plan = useQuery({ queryKey: planViewKey, queryFn: getPlanView });
  const name = planNames(plan.data).projects.get(projectId) ?? t("deviations.filter.projectUnknown", { id: projectId });
  return (
    <Group gap="xs" role="group" aria-label={t("deviations.filter.scopeAria")}>
      <Badge
        color="gray"
        tt="none"
        size="lg"
        rightSection={<CloseButton size="xs" aria-label={t("deviations.filter.removeProject")} onClick={onRemove} />}
      >
        {t("deviations.filter.project", { name })}
      </Badge>
    </Group>
  );
}
