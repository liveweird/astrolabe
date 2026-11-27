import type { ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import { Stack, Text, Title } from "@mantine/core";
import { ANCHORED_HEADING_STYLE } from "../utils/layout";

/**
 * The Unscheduled h3 and, while the tray holds milestones, its intro line (who may place them: `canSchedule`) above the tray itself
 * (`children`) - the project and team pages' section. With `headingRef` the h3 is a programmatic focus target (`tabIndex` -1, never a tab stop, scroll margin
 * below the app header): the project page's `?milestones=unscheduled` arrival (`useUnscheduledArrival`).
 */
export default function UnscheduledTraySection({
  hasItems,
  canSchedule,
  headingRef,
  children,
}: {
  hasItems: boolean;
  canSchedule: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap="xs">
      <Title order={3} size="h4" ref={headingRef} {...(headingRef === undefined ? {} : { tabIndex: -1, style: ANCHORED_HEADING_STYLE })}>
        {t("project.unscheduledTitle")}
      </Title>
      {hasItems && (
        <Text size="sm" c="dimmed">
          {canSchedule ? t("project.trayIntro") : t("project.trayIntroReadOnly")}
        </Text>
      )}
      {children}
    </Stack>
  );
}
