import { useTranslation } from "react-i18next";
import { Group, Loader, Text, Title } from "@mantine/core";

/** The timeline section's h3 and, while a write runs, the "Saving…" status beside it (shared by the project and team pages). */
export default function TimelineTitle({ title, saving }: { title: string; saving: boolean }) {
  const { t } = useTranslation();
  return (
    <Group gap="sm" align="center">
      <Title order={3} size="h4">
        {title}
      </Title>
      {saving && (
        <Group gap={6} role="status">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            {t("project.saving")}
          </Text>
        </Group>
      )}
    </Group>
  );
}
