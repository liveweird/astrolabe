import { useEffect, useState } from "react";
import { Link as RouterLink, Navigate } from "react-router-dom";
import { Button, Stack, Text } from "@mantine/core";
import { IconSitemap, IconTimelineEvent } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getPlanView, planViewKey } from "../api/plan";
import { forgetLastProject, readLastProject } from "../hooks/useLastProject";
import { planNames } from "../utils/planNames";
import { planPath, projectPath } from "../utils/planLinks";
import EmptyState from "./EmptyState";
import ErrorAlert from "./ErrorAlert";
import FormErrorAlert from "./FormErrorAlert";
import LoadingBlock from "./LoadingBlock";
import PageHeader from "./PageHeader";
import ProjectPicker from "./ProjectPicker";

/**
 * The bare `/projects` (1.29). The remembered project the plan view (even a cached one) holds opens at once, by `replace`, so Back never returns to a
 * redirect. Otherwise a remembered id is decided only by a fresh SUCCESSFUL answer: it lacks the project, so the id is forgotten and the page says
 * none is picked, with the picker. A failed read (with or without a cache) is a failure alert and forgets nothing; offline (the read is paused) nothing
 * is forgotten either: the cached plan still serves the picker beside a quiet note, and without a cache the page says it cannot reach the server.
 * A plan with no project at all says so and points to the Plan.
 */
export default function ProjectsStart() {
  const { t } = useTranslation();
  const plan = useQuery({ queryKey: planViewKey, queryFn: getPlanView });
  // Read once on arrival: forgetting it below must not turn a later refetch into a fresh decision.
  const [remembered] = useState(readLastProject);
  const projects = planNames(plan.data).projects;
  const holds = remembered !== null && projects.has(remembered);
  const fresh = plan.isFetchedAfterMount && plan.isSuccess;
  const gone = remembered !== null && !holds && fresh;
  useEffect(() => {
    if (gone && remembered !== null) forgetLastProject(remembered);
  }, [gone, remembered]);

  if (holds) return <Navigate to={projectPath(remembered)} replace />;
  const title = t("project.pickTitle");
  const offline = plan.fetchStatus === "paused";
  // Undecided: a remembered id the plan does not (yet) hold waits for a fresh answer; with nothing remembered the plan (cached or not) is all there is to wait for.
  const waiting = !plan.isError && !offline && (plan.data === undefined || (remembered !== null && !fresh));
  if (plan.isError || waiting || (offline && plan.data === undefined)) {
    return (
      <Stack gap="md">
        <PageHeader title={title} />
        {plan.isError ? <ErrorAlert error={plan.error} title={t("project.loadFailed")} /> : offline ? <FormErrorAlert>{t("project.offline")}</FormErrorAlert> : <LoadingBlock />}
      </Stack>
    );
  }
  return (
    <Stack gap="md">
      <PageHeader title={title} description={t("project.pickIntro")} />
      {offline && (
        <Text c="dimmed" size="sm" role="note">
          {t("project.offline")}
        </Text>
      )}
      {projects.size === 0 ? (
        <EmptyState
          icon={IconSitemap}
          label={t("project.noProjects")}
          hint={t("project.noProjectsHint")}
          action={
            <Button component={RouterLink} to={planPath} variant="default">
              {t("project.openPlan")}
            </Button>
          }
        />
      ) : (
        <>
          <ProjectPicker projectId={null} />
          <EmptyState icon={IconTimelineEvent} label={t("project.nonePicked")} />
        </>
      )}
    </Stack>
  );
}
