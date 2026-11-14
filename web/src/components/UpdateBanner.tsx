import { Alert, Button, Group } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useServedBuild } from "../hooks/useServedBuild";

/**
 * The deploy notice (1.17): one line at the top of the main area, above every page, once the server serves another
 * build than this tab runs. Not a toast and not a dialog; nothing is dismissed (it stays until the reload) and
 * nothing reloads by itself. Gray, the neutral state. Mounted once in the shell (App.tsx).
 */
export default function UpdateBanner() {
  const { t } = useTranslation();
  const { outdated } = useServedBuild();
  if (!outdated) return null;
  return (
    <Alert color="gray" variant="light" role="status" mb="md" data-print="hide">
      <Group justify="space-between" gap="sm" wrap="wrap">
        <span>{t("appShell.update.text")}</span>
        <Button variant="default" size="compact-sm" onClick={() => window.location.reload()}>
          {t("common.action.reload")}
        </Button>
      </Group>
    </Alert>
  );
}
