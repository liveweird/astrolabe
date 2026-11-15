import { Badge } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { DependencyListRow } from "../api/dependencyList";

/** The link's status: a red badge naming the shortfall, or a gray one - never colour alone. Shared by the project page's table and the Dependencies page. */
export function DependencyStatusBadge({ check }: { check: DependencyListRow["check"] }) {
  const { t } = useTranslation();
  if (check.status === "VIOLATED") {
    return (
      // miw max-content: a badge shrinks (and clips its sentence with an ellipsis) when the table is tight; the column grows instead. tt none: the badge holds a sentence, not a label.
      <Badge color="red" variant="light" tt="none" miw="max-content">
        {t("project.dependency.status.violated", { count: check.shortfallDays ?? 0 })}
      </Badge>
    );
  }
  return (
    <Badge color="gray" variant="light" tt="none" miw="max-content">
      {t(check.status === "OK" ? "project.dependency.status.ok" : "project.dependency.status.unscheduled")}
    </Badge>
  );
}

/** The lag in working days; a negative one is a lead. */
export function DependencyLagText({ lagDays }: { lagDays: number }) {
  const { t } = useTranslation();
  return <>{lagDays < 0 ? `${t("project.dependency.lag", { count: lagDays })} ${t("project.dependency.lead")}` : t("project.dependency.lag", { count: lagDays })}</>;
}
