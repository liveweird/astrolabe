import type { ReactNode } from "react";
import { Anchor, Badge, Group, Paper, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { IconGitCompare, IconListNumbers, IconSitemap, type Icon } from "@tabler/icons-react";
import type { ParseKeys } from "i18next";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { getHomeView, HOME_STALE_MS, HOME_VIEW_KEY, type HomePlan } from "../api/home";
import BadgeLink from "../components/BadgeLink";
import ErrorAlert from "../components/ErrorAlert";
import HomeMine from "../components/HomeMine";
import { JiraStaleNote } from "../components/JiraChips";
import PageHeader from "../components/PageHeader";
import { useOpenDeviationCounts, type OpenCounts } from "../hooks/useOpenDeviationCounts";
import { violatedDependenciesPath } from "../utils/dependencyListLinks";
import { deviationsPath } from "../utils/deviationLinks";
import { unscheduledMilestonesPath } from "../utils/milestoneLinks";
import { planPath, roadmapFilteredPath, roadmapPath } from "../utils/planLinks";
import { isStaleSource } from "../utils/staleness";
import { teamLoadWarningPath } from "../utils/teamLoadLinks";

/** The room a card's figure group keeps while the read has not answered (px, about the lines it will hold), so the card's link stays where it is. */
const PLAN_FIGURES_MIN_HEIGHT = 120;
const ROADMAP_FIGURES_MIN_HEIGHT = 148; // two lines plus up to five badges wrapping to three rows at the md card width

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

/**
 * One source's line: its label and the orange/gray badges of the Deviations page (a zero badge is omitted); nothing at zero (no "nothing open" claim).
 * `stale` (the source "may be out of date", 1.18) adds its sentence under the line, and only while the line itself shows: no figure, no qualifier.
 */
function OpenLine({ label, counts, stale }: { label: string; counts: OpenCounts | null; stale: ReactNode }) {
  const { t } = useTranslation();
  if (counts === null || counts.warnings + counts.infos === 0) return null;
  return (
    <>
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
      {stale}
    </>
  );
}

/**
 * The Plan card's figures (what there is, nothing filtered, as the Programs page's facts line) - empty, but as tall, until the read answers. The
 * "not scheduled yet" line is a link to the Milestones page's unscheduled list when positive: that list's total and this figure count one set.
 */
function PlanFigures({ plan }: { plan: HomePlan | undefined }) {
  const { t } = useTranslation();
  return (
    <Stack gap={2} role="group" aria-label={t("home.plan.factsAria")} mih={PLAN_FIGURES_MIN_HEIGHT}>
      {plan && (
        <>
          <Text size="sm">{t("programs.facts.workStreams", { count: plan.workStreams })}</Text>
          <Text size="sm">{t("programs.facts.programs", { count: plan.programs })}</Text>
          <Text size="sm">{t("programs.facts.projects", { count: plan.projects })}</Text>
          <Text size="sm">{t("teams.view.milestones", { count: plan.milestones })}</Text>
          {plan.unscheduledMilestones > 0 ? (
            <Anchor component={RouterLink} to={unscheduledMilestonesPath()} size="sm">
              {t("home.plan.notScheduled", { count: plan.unscheduledMilestones })}
            </Anchor>
          ) : (
            <Text size="sm">{t("home.plan.notScheduled", { count: plan.unscheduledMilestones })}</Text>
          )}
        </>
      )}
    </Stack>
  );
}

/**
 * The Roadmap card's figures: the ranked and unranked counts and the warnings and infos of the Roadmap's facts line, then what else needs attention
 * (a badge only when positive). The unranked count links to the Roadmap with "unranked projects only", the warnings badge to the projects with a warning and the
 * infos badge to the projects with an info (a link is shown as written, so no remembered filter narrows it) and the two capacity figures to the Team load page filtered to them. Violated dependencies count every link once, a link inside one project included, so
 * they are worded as dependencies, not as the arrows the Roadmap draws between projects; the red badge opens the Dependencies page narrowed to the violated ones.
 */
function RoadmapFigures({ plan, jiraStale }: { plan: HomePlan | undefined; jiraStale: boolean }) {
  const { t } = useTranslation();
  const warnings = plan ? t("roadmap.facts.warnings", { count: plan.flags.warnings }) : "";
  const infos = plan ? t("roadmap.facts.infos", { count: plan.flags.infos }) : "";
  const warningsPath = roadmapFilteredPath({ filters: { severity: "WARNING" } });
  const infosPath = roadmapFilteredPath({ filters: { severity: "INFO" } });
  return (
    <Stack gap={4} role="group" aria-label={t("home.roadmap.factsAria")} mih={ROADMAP_FIGURES_MIN_HEIGHT}>
      {plan && (
        <>
          <Text size="sm">{t("roadmap.facts.ranked", { count: plan.rankedProjects })}</Text>
          {plan.unrankedProjects > 0 ? (
            <Anchor component={RouterLink} to={roadmapFilteredPath({ filters: { unrankedOnly: true } })} size="sm">
              {t("roadmap.facts.unranked", { count: plan.unrankedProjects })}
            </Anchor>
          ) : (
            <Text size="sm">{t("roadmap.facts.unranked", { count: plan.unrankedProjects })}</Text>
          )}
          <Group gap="xs">
            {plan.flags.warnings > 0 && (
              <BadgeLink to={warningsPath} color="orange" ariaLabel={t("home.roadmap.warningsAria", { figure: warnings })}>
                {warnings}
              </BadgeLink>
            )}
            {plan.flags.infos > 0 && (
              <BadgeLink to={infosPath} color="gray" ariaLabel={t("home.roadmap.infosAria", { figure: infos })}>
                {infos}
              </BadgeLink>
            )}
            {plan.conflicts > 0 && (
              <BadgeLink to={violatedDependenciesPath()} color="red">
                {t("home.roadmap.conflicts", { count: plan.conflicts })}
              </BadgeLink>
            )}
            {plan.overloadedTeams > 0 && (
              <BadgeLink to={teamLoadWarningPath("overloaded")} color="orange">
                {t("home.roadmap.overloadedTeams", { count: plan.overloadedTeams })}
              </BadgeLink>
            )}
            {plan.wipExceededTeams > 0 && (
              <BadgeLink to={teamLoadWarningPath("wip")} color="orange">
                {t("home.roadmap.wipTeams", { count: plan.wipExceededTeams })}
              </BadgeLink>
            )}
          </Group>
          {jiraStale && <JiraStaleNote />}
        </>
      )}
    </Stack>
  );
}

/**
 * The landing page: an intro and three cards that link to the plan, the roadmap and the deviations. The Plan and Roadmap cards show the plan's figures
 * from ONE read (`GET /views/home`, shown as the server derives them), the Deviations card the OPEN deviation counts (`useOpenDeviationCounts`). The
 * links never depend on a read; a failed Home read is ONE inline alert under the cards (a failed re-read keeps the figures it has and the "Yours" section
 * below the alert; a failed first read leaves no section), a failed deviation read the alert inside the Deviations card. "May be out of date" follows the page each figure links to (`isStaleSource` and its folds).
 */
export default function Home() {
  const { t } = useTranslation();
  const { jira, flow, jiraStale, flowStale, error } = useOpenDeviationCounts();
  const home = useQuery({ queryKey: HOME_VIEW_KEY, queryFn: getHomeView, staleTime: HOME_STALE_MS });
  const plan = home.data?.plan;
  return (
    <Stack gap="md">
      <PageHeader title={t("home.title")} description={t("home.intro")} />
      <SimpleGrid cols={{ base: 1, md: 3 }}>
        <HomeCard icon={IconSitemap} title="appShell.nav.plan" text="home.plan.text" open="home.plan.open" to={planPath}>
          <PlanFigures plan={plan} />
        </HomeCard>
        <HomeCard icon={IconListNumbers} title="appShell.nav.roadmap" text="home.roadmap.text" open="home.roadmap.open" to={roadmapPath}>
          <RoadmapFigures plan={plan} jiraStale={home.data?.jiraSites.some(isStaleSource) ?? false} />
        </HomeCard>
        <HomeCard icon={IconGitCompare} title="appShell.nav.deviations" text="home.deviations.text" open="home.deviations.open" to={deviationsPath}>
          {error != null && <ErrorAlert error={error} title={t("home.deviations.loadFailed")} />}
          <OpenLine label={t("home.deviations.openJira")} counts={jira} stale={jiraStale && <JiraStaleNote />} />
          <OpenLine
            label={t("home.deviations.openFlow")}
            counts={flow}
            stale={
              flowStale && (
                <Text size="sm" c="dimmed">
                  {t("home.deviations.flowStale")}
                </Text>
              )
            }
          />
        </HomeCard>
      </SimpleGrid>
      {home.isError && <ErrorAlert error={home.error} title={t("home.figures.loadFailed")} />}
      {(home.data !== undefined || home.isPending) && <HomeMine view={home.data} flowStale={flowStale} />}
    </Stack>
  );
}
