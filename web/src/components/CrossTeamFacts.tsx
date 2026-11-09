import { Alert, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

/**
 * The facts line of an open cross-team run: how many passes the server made and whether the dates settled. A run that did NOT settle (the
 * teams' links form a loop, so every pass moved something again) is an orange note that says what that means: the dates are the last pass's
 * and the link warnings decide. Visible only (`role="note"`): the page's status region has said the run is ready.
 */
export default function CrossTeamFacts({ passes, settled }: { passes: number; settled: boolean }) {
  const { t } = useTranslation();
  return settled ? (
    <Text size="sm" c="dimmed" role="note">
      {t("scheduleProposals.facts.settled", { count: passes })}
    </Text>
  ) : (
    <Alert color="orange" variant="light" role="note">
      {t("scheduleProposals.facts.unsettled", { count: passes })}
    </Alert>
  );
}
