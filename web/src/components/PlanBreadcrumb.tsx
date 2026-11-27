import type { MouseEvent } from "react";
import { Anchor, Group, Text } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";

/** One step of the way down to the focus: its name, and where its link goes (the last step, where the user is, has none). */
export type Crumb = { key: string; name: string; href: string | null; onFollow: (event: MouseEvent) => void };

/**
 * The way back from a focus ("Show only this"): "All work streams", then the work stream and, for a program, the program. Every step but the last is a
 * real link (the address changes, Back works). It is shown only while the plan is focused, and is no content on paper. The steps are the Plan's own focus
 * navigation, a control (rule 2 of "Entity links"), not the names' links: a work stream's or program's NAME elsewhere (the tree) leads to the Roadmap overview.
 */
export default function PlanBreadcrumb({ allHref, onAll, trail }: { allHref: string; onAll: (event: MouseEvent) => void; trail: readonly Crumb[] }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("plan.focus.breadcrumbAria")} data-print="hide">
      <Group gap={6} component="ol" wrap="wrap" m={0} p={0} style={{ listStyle: "none" }}>
        <li>
          <Anchor component={RouterLink} to={allHref} size="sm" onClick={onAll}>
            {t("plan.focus.all")}
          </Anchor>
        </li>
        {trail.map((crumb) => (
          <li key={crumb.key}>
            <Group gap={6} component="span" wrap="nowrap">
              <IconChevronRight size={14} aria-hidden="true" />
              {crumb.href === null ? (
                <Text span size="sm" fw={600} aria-current="location">
                  {crumb.name}
                </Text>
              ) : (
                <Anchor component={RouterLink} to={crumb.href} size="sm" onClick={crumb.onFollow}>
                  {crumb.name}
                </Anchor>
              )}
            </Group>
          </li>
        ))}
      </Group>
    </nav>
  );
}
