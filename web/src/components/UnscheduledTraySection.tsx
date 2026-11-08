import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Stack, Text, Title } from "@mantine/core";

/**
 * The Unscheduled h3 and, while the tray holds milestones, its intro line (who may place them: `canSchedule`) above the tray itself
 * (`children`) - the project and team pages' section.
 */
export default function UnscheduledTraySection({ hasItems, canSchedule, children }: { hasItems: boolean; canSchedule: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Stack gap="xs">
      <Title order={3} size="h4">
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
