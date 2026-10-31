import { Stack } from "@mantine/core";
import { IconCompass } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";

/**
 * The landing page. In v0.1.0 it is a placeholder: the planning views (work streams, programs,
 * projects and the timeline) arrive in 0.2 and replace the empty state.
 */
export default function Home() {
  const { t } = useTranslation();
  return (
    <Stack gap="md">
      <PageHeader title={t("home.title")} />
      <EmptyState icon={IconCompass} label={t("home.empty.label")} hint={t("home.empty.hint")} />
    </Stack>
  );
}
