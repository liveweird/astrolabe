import type { ReactNode } from "react";
import { Anchor, Badge, Group, Paper, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { IconGitCompare, IconListNumbers, IconSitemap, type Icon } from "@tabler/icons-react";
import type { ParseKeys } from "i18next";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import ErrorAlert from "../components/ErrorAlert";
import PageHeader from "../components/PageHeader";
import { useOpenDeviationCounts, type OpenCounts } from "../hooks/useOpenDeviationCounts";
import { deviationsPath } from "../utils/deviationLinks";
import { planPath, roadmapPath } from "../utils/planLinks";

/** One landing card: the nav's icon and label as its h3, one sentence, whatever the card shows live (`children`), then the link. */
function HomeCard({ icon: CardIcon, title, text, open, to, children }: { icon: Icon; title: ParseKeys; text: ParseKeys; open: ParseKeys; to: string; children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Group gap="xs" wrap="nowrap">
          <CardIcon size={20} aria-hidden />
          <Title order={3} size="h4">
            {t(title)}
          </Title>
        </Group>
        <Text size="sm" c="dimmed">
          {t(text)}
        </Text>
        {children}
        <Anchor component={RouterLink} to={to} size="sm" fw={500}>
          {t(open)}
        </Anchor>
      </Stack>
    </Paper>
  );
}

/** One source's line: its label and the orange/gray badges of the Deviations page (a zero badge is omitted); nothing at zero (no "nothing open" claim). */
function OpenLine({ label, counts }: { label: string; counts: OpenCounts | null }) {
  const { t } = useTranslation();
  if (counts === null || counts.warnings + counts.infos === 0) return null;
  return (
    <Group gap="xs">
      <Text size="sm">{label}</Text>
      {counts.warnings > 0 && (
        <Badge color="orange" variant="light" tt="none">
          {t("deviations.totals.warnings", { count: counts.warnings })}
        </Badge>
      )}
      {counts.infos > 0 && (
        <Badge color="gray" variant="light" tt="none">
          {t("deviations.totals.infos", { count: counts.infos })}
        </Badge>
      )}
    </Group>
  );
}

/**
 * The landing page: an intro and three cards that link to the plan, the roadmap and the deviations. The only live figures are the OPEN deviation counts
 * (`useOpenDeviationCounts`); a failed read is an inline alert inside the Deviations card and the links never depend on it.
 */
export default function Home() {
  const { t } = useTranslation();
  const { jira, flow, error } = useOpenDeviationCounts();
  return (
    <Stack gap="md">
      <PageHeader title={t("home.title")} description={t("home.intro")} />
      <SimpleGrid cols={{ base: 1, md: 3 }}>
        <HomeCard icon={IconSitemap} title="appShell.nav.plan" text="home.plan.text" open="home.plan.open" to={planPath} />
        <HomeCard icon={IconListNumbers} title="appShell.nav.roadmap" text="home.roadmap.text" open="home.roadmap.open" to={roadmapPath} />
        <HomeCard icon={IconGitCompare} title="appShell.nav.deviations" text="home.deviations.text" open="home.deviations.open" to={deviationsPath}>
          {error != null && <ErrorAlert error={error} title={t("home.deviations.loadFailed")} />}
          <OpenLine label={t("home.deviations.openJira")} counts={jira} />
          <OpenLine label={t("home.deviations.openFlow")} counts={flow} />
        </HomeCard>
      </SimpleGrid>
    </Stack>
  );
}
