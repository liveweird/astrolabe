import { Badge, Group } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { WeekLoad } from "../api/teams";
import { mdText } from "../utils/weekLoadText";

/**
 * A week's verdicts as words — never colour alone: ORANGE "Overloaded · +2.50 MD" and/or ORANGE "Over WIP limit" (both warnings, nothing
 * moves), else a gray "OK" or, when the team has no capacity yet that week, a gray "No capacity". A week the server marks `flowCapacity`
 * (1.9: an open Flow capacity deviation's held days meet it) adds "Differs from Flow" beside the verdict — orange for WARNING, gray for INFO.
 * Shared by the team page's weekly table and the Team load page's weeks with a warning (the same cells, 1.21); the text helpers sit in
 * `utils/weekLoadText.ts` (fast refresh: a component file exports components only).
 */
export function WeekStatus({ week }: { week: WeekLoad }) {
  const { t } = useTranslation();
  const warned = week.overloaded || week.wipExceeded;
  return (
    <Group gap={6} wrap="nowrap">
      {week.overloaded && (
        // miw max-content: a badge shrinks (and clips its sentence with an ellipsis) when the table is tight; the column grows instead.
        <Badge color="orange" tt="none" miw="max-content">
          {t("teams.view.status.overloaded", { md: mdText(week.overloadMd ?? week.load - (week.capacity ?? 0)) })}
        </Badge>
      )}
      {week.wipExceeded && (
        <Badge color="orange" tt="none" miw="max-content">
          {t("teams.view.status.wipExceeded")}
        </Badge>
      )}
      {!warned && (
        <Badge color="gray" tt="none" miw="max-content">
          {t(week.capacity === null ? "teams.view.status.noCapacity" : "teams.view.status.ok")}
        </Badge>
      )}
      {week.flowCapacity != null && (
        <Badge color={week.flowCapacity === "WARNING" ? "orange" : "gray"} tt="none" miw="max-content" data-flow-badge={week.flowCapacity}>
          {t("teams.view.status.flowCapacity")}
        </Badge>
      )}
    </Group>
  );
}
