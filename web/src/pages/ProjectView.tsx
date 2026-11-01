import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Alert, Badge, Button, Group, Loader, Stack, Text, Title, VisuallyHidden } from "@mantine/core";
import { IconCalendarStats, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { EndpointRef, ProjectDependency } from "../api/dependencies";
import { ApiError } from "../api/http";
import { deleteMilestone, type ProjectMilestone, type ProjectView as ProjectViewDocument } from "../api/milestones";
import { deleteProject } from "../api/plan";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal";
import EditPageLoadState from "../components/EditPageLoadState";
import EmptyState from "../components/EmptyState";
import DependencyEditorModal from "../components/DependencyEditorModal";
import ErrorAlert from "../components/ErrorAlert";
import FormErrorAlert from "../components/FormErrorAlert";
import MilestoneEditorModal from "../components/MilestoneEditorModal";
import MilestoneScheduleModal from "../components/MilestoneScheduleModal";
import PageHeader from "../components/PageHeader";
import CriticalChain from "../components/CriticalChain";
import IdleGaps from "../components/IdleGaps";
import ProjectDependencies from "../components/ProjectDependencies";
import ProjectEditorModal from "../components/ProjectEditorModal";
import ProjectTimeline, { ProjectTray, type MilestoneActions } from "../components/ProjectTimeline";
import TimelineDndContext from "../components/TimelineDndContext";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { useMilestoneSchedule } from "../hooks/useMilestoneSchedule";
import { isBoolean, isOneOf, useStoredState } from "../hooks/useStoredState";
import { localIsoDate } from "../utils/isoDate";
import { planPath } from "../utils/planLinks";
import { conflictCount, linksOfMilestone } from "../utils/projectDependencies";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { loadErrorMessage, saveErrorMessage } from "../utils/saveError";
import { dropOutcome } from "../utils/timelineDrag";
import { defaultRange, makeScale, MILESTONE_ZOOMS, toEpochDay, type Zoom } from "../utils/timelineScale";

/** The schedule dialog remembers the plan revision of the view it was opened on: its save must stale-409 if THIS milestone moved since. */
type Scheduling = { milestone: ProjectMilestone; revision: number };

/**
 * `dependency` is the Add dependency dialog; `successor` prefills it (the row menu's shortcut), null = the project itself.
 * `editDependency` is the same dialog on an existing link (type and lag only).
 */
type Editor =
  | { kind: "create" }
  | { kind: "edit"; milestone: ProjectMilestone }
  | { kind: "project" }
  | { kind: "dependency"; successor: EndpointRef | null }
  | { kind: "editDependency"; dependency: ProjectDependency };

/** One badge per non-zero drift figure: orange when the project runs LATER than its target (a warning), gray when it is ahead. */
function driftBadges(drift: NonNullable<ProjectViewDocument["drift"]>, t: TFunction): { key: string; label: string; late: boolean }[] {
  const figures = [
    { key: "end", days: drift.endDays, late: "project.drift.endLate", early: "project.drift.endEarly" },
    { key: "start", days: drift.startDays, late: "project.drift.startLate", early: "project.drift.startEarly" },
  ] as const;
  return figures
    .filter(({ days }) => days !== 0)
    .map(({ key, days, late, early }) => ({ key, late: days > 0, label: t(days > 0 ? late : early, { count: Math.abs(days) }) }));
}

/** The facts line under the title: the target window, the derived span and how the span drifts from the target. */
function ProjectFacts({ view }: { view: ProjectViewDocument }) {
  const { t } = useTranslation();
  const { targetStart, targetEnd } = view.project;
  const badges = view.drift === null ? [] : driftBadges(view.drift, t);
  const conflicts = conflictCount(view);
  return (
    <Group gap="md" role="group" aria-label={t("project.factsAria")}>
      <Text size="sm">{targetStart !== null && targetEnd !== null ? t("project.windowLine", { start: targetStart, end: targetEnd }) : t("project.noWindow")}</Text>
      <Text size="sm">{view.span !== null ? t("project.spanLine", { start: view.span.start, end: view.span.end }) : t("project.nothingScheduled")}</Text>
      {view.drift !== null && badges.length === 0 && (
        <Badge color="gray" variant="light">
          {t("project.drift.onTarget")}
        </Badge>
      )}
      {badges.map((badge) => (
        <Badge key={badge.key} color={badge.late ? "orange" : "gray"} variant="light">
          {badge.label}
        </Badge>
      ))}
      {conflicts > 0 && (
        <Badge color="red" variant="light">
          {t("project.conflicts", { count: conflicts })}
        </Badge>
      )}
      {view.idleGaps.length > 0 && (
        <Badge color="gray" variant="light">
          {t("timeline.idle.badge", { count: view.idleGaps.length })}
        </Badge>
      )}
    </Group>
  );
}

/**
 * The project view (`/projects/:id`): the project's facts, its scheduled milestones on the shared timeline and the Unscheduled
 * tray. What each control offers comes from the view's `can:{…}` flags — the owner chain edits a milestone's plan fields, ONLY
 * the team's manager or an ADMIN moves its dates, so a bar is read-only for anyone else. Every date change (a drag, a resize, the
 * Schedule button, the schedule dialog) goes through the one write path `useMilestoneSchedule`.
 */
export default function ProjectView() {
  const { id } = useParams();
  // Keyed by the id: another project's page starts from its own range and editors.
  return <ProjectPage key={id} id={Number(id)} />;
}

function ProjectPage({ id }: { id: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const schedule = useMilestoneSchedule(id);
  const { view, query } = schedule;
  const [zoom, setZoom] = useStoredState<Zoom>("timeline.zoom", "week", isOneOf(MILESTONE_ZOOMS));
  // The critical-path highlight (v0.7), remembered like the zoom: the Slack column, the bar and arrow emphasis, the badges and the Critical chain section.
  const [criticalPath, setCriticalPath] = useStoredState("timeline.criticalPath", false, isBoolean);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [scheduling, setScheduling] = useState<Scheduling | null>(null);
  // The earliest and latest day this page has shown: the range only ever grows, so a drag never shifts the bars under the pointer.
  const [seen, setSeen] = useState<{ min: string; max: string } | null>(null);
  // "Today" is the viewer's own calendar day (their local date), not UTC: the today line and the Schedule button agree with their wall calendar.
  const today = localIsoDate();

  const refreshPlan = () => refreshQueriesAfterMutation(queryClient, ["plan"]);
  const removeMilestone = useDeleteConfirm<{ milestone: ProjectMilestone; links: number }>({
    mutationFn: ({ milestone }) => deleteMilestone(milestone.id),
    onSuccess: refreshPlan,
    successMessage: t("project.toast.milestoneDeleted"),
  });
  const removeProject = useDeleteConfirm<{ id: number; name: string; milestones: number; links: number }>({
    mutationFn: (project) => deleteProject(project.id),
    // Leave first: the unmounted page's query is then only invalidated, never refetched for a project that is gone.
    onSuccess: async () => {
      navigate(planPath);
      await refreshQueriesAfterMutation(queryClient, ["plan"], ["roadmap"]);
    },
    successMessage: t("project.toast.projectDeleted"),
  });

  if (!view) {
    const notFound = !Number.isInteger(id) || (query.error instanceof ApiError && query.error.status === 404);
    return (
      <EditPageLoadState
        isLoading={query.isLoading}
        message={notFound ? t("project.notFound") : loadErrorMessage(query.error, t)}
        backTo={planPath}
        backLabel={t("project.backToPlan")}
        title={t("project.pageTitle")}
      />
    );
  }

  const { project } = view;
  // Every day the page shows: the milestones, the window and every link end (a ghost row's, so an arrow to a far-away one is in range).
  const linkEnds = view.dependencies.flatMap((d) => [d.predecessor, d.successor]);
  const dates = [...view.scheduled.flatMap((m) => [m.startDate, m.endDate]), ...linkEnds.flatMap((e) => [e.startDate, e.endDate]), project.targetStart, project.targetEnd].filter(
    (d): d is string => d !== null,
  );
  if (dates.length > 0) {
    const min = dates.reduce((a, b) => (b < a ? b : a));
    const max = dates.reduce((a, b) => (b > a ? b : a));
    if (seen === null || min < seen.min || max > seen.max) setSeen({ min: seen !== null && seen.min < min ? seen.min : min, max: seen !== null && seen.max > max ? seen.max : max });
  }
  const scale = makeScale(zoom, defaultRange(seen === null ? [] : [seen.min, seen.max], today, zoom));

  /** The Schedule button: one calendar week from the later of today and the project's target start (the tray's pointer drop uses the same week). */
  const scheduleByButton = (milestone: ProjectMilestone) => {
    const start = project.targetStart !== null && project.targetStart > today ? project.targetStart : today;
    const span = dropOutcome("tray", null, 0, toEpochDay(start));
    if (span !== null) schedule.commit(milestone.id, span.start, span.end, { announce: true });
  };

  /** The dialog closes once its change is taken, or when its milestone is gone (nothing left to edit); a refusal keeps it open, saying so inside. */
  const commitFromDialog = (target: Scheduling, start: string | null, end: string | null) => {
    const taken = schedule.commit(target.milestone.id, start, end, { announce: true, revision: target.revision, ownRefusalAlert: true });
    if (taken || !schedule.has(target.milestone.id)) setScheduling(null);
  };

  const actions: MilestoneActions = {
    edit: (milestone) => setEditor({ kind: "edit", milestone }),
    editSchedule: (milestone) => setScheduling({ milestone, revision: view.revision }),
    unschedule: (milestone) => schedule.commit(milestone.id, null, null, { announce: true }),
    remove: (milestone) => removeMilestone.requestDelete({ milestone, links: linksOfMilestone(view, milestone.id) }),
    schedule: scheduleByButton,
    addDependency: (milestone) => setEditor({ kind: "dependency", successor: { kind: "MILESTONE", id: milestone.id } }),
  };
  const milestoneCount = view.scheduled.length + view.unscheduled.length;
  const canTrayEdit = view.unscheduled.some((m) => m.can.schedule);
  const closeEditor = () => setEditor(null);
  const dependencies = (
    <ProjectDependencies
      view={view}
      onAdd={() => setEditor({ kind: "dependency", successor: null })}
      onEdit={(dependency) => setEditor({ kind: "editDependency", dependency })}
      showCritical={criticalPath}
    />
  );
  const criticalToggle = (
    <Button size="compact-sm" variant={criticalPath ? "filled" : "default"} aria-pressed={criticalPath} onClick={() => setCriticalPath(!criticalPath)}>
      {t("timeline.criticalToggle")}
    </Button>
  );
  const saved = async () => {
    closeEditor();
    await refreshQueriesAfterMutation(queryClient, ["plan"], ["roadmap"]);
  };
  const deleteErrors = (error: unknown) =>
    saveErrorMessage(error, t, {
      forbidden: "project.saveForbidden",
      notFound: "project.saveGone",
      failedStatus: "common.error.actionFailedStatus",
      failed: "common.error.actionFailed",
    });

  return (
    <Stack gap="md">
      <PageHeader
        title={project.name}
        description={
          <>
            {project.description && (
              <Text span display="block">
                {project.description}
              </Text>
            )}
            <Text span display="block">
              {t("project.metaLine", { program: project.programName, workStream: project.workStreamName, owner: project.ownerName })}
            </Text>
          </>
        }
        backTo={{ to: planPath, label: t("project.backToPlan") }}
        actions={
          <>
            {project.can.createMilestone && (
              <Button leftSection={<IconPlus size={16} />} onClick={() => setEditor({ kind: "create" })}>
                {t("project.newMilestone")}
              </Button>
            )}
            {(project.can.edit || project.can.editTargetWindow) && (
              <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => setEditor({ kind: "project" })}>
                {t("common.action.edit")}
              </Button>
            )}
            {project.can.delete && (
              <Button color="red" variant="light" leftSection={<IconTrash size={16} />} onClick={() => removeProject.requestDelete({ id: project.id, name: project.name, milestones: milestoneCount, links: view.dependencies.length })}>
                {t("common.action.delete")}
              </Button>
            )}
          </>
        }
      />
      <ProjectFacts view={view} />

      {query.isError && <ErrorAlert error={query.error} title={t("project.loadFailed")} />}
      {/* The two notices below are visible only: the status region below says them (an Alert's implicit role="alert" would read each twice). */}
      {schedule.refused && (
        <Alert color="orange" variant="light" role="note">
          {t("project.busy")}
        </Alert>
      )}
      {schedule.gone && (
        <Alert color="orange" variant="light" role="note">
          {t("project.milestoneGone")}
        </Alert>
      )}
      {schedule.stale && <FormErrorAlert>{t("project.stale")}</FormErrorAlert>}
      {schedule.error && <FormErrorAlert>{schedule.error}</FormErrorAlert>}
      {/* Button- and dialog-driven schedule changes are announced here (a drag is announced by dnd-kit's own live region). */}
      <VisuallyHidden role="status" aria-live="polite">
        {schedule.announcement}
      </VisuallyHidden>

      {milestoneCount === 0 ? (
        <EmptyState icon={IconCalendarStats} label={t("project.noMilestones")} hint={project.can.createMilestone ? t("project.noMilestonesHint") : t("project.noMilestonesHintReadOnly")} />
      ) : (
        <TimelineDndContext scale={scale} onSchedule={(barId, start, end) => schedule.commit(Number(barId), start, end)}>
          <Stack gap="xs">
            <Group gap="sm" align="center">
              <Title order={3} size="h4">
                {t("project.timelineTitle")}
              </Title>
              {schedule.pending && (
                <Group gap={6} role="status">
                  <Loader size="xs" />
                  <Text size="sm" c="dimmed">
                    {t("project.saving")}
                  </Text>
                </Group>
              )}
            </Group>
            <ProjectTimeline
              view={view}
              scale={scale}
              onZoomChange={setZoom}
              today={today}
              busy={schedule.pending}
              actions={actions}
              label={t("project.timelineAria")}
              criticalPath={criticalPath}
              toolbar={criticalToggle}
            />
          </Stack>
          <Stack gap="xs">
            <Title order={3} size="h4">
              {t("project.unscheduledTitle")}
            </Title>
            {view.unscheduled.length > 0 && (
              <Text size="sm" c="dimmed">
                {canTrayEdit ? t("project.trayIntro") : t("project.trayIntroReadOnly")}
              </Text>
            )}
            <ProjectTray view={view} actions={actions} label={t("project.trayAria")} />
          </Stack>
        </TimelineDndContext>
      )}
      {/* After the tray, not between: the tray's pointer drop needs it close to the timeline (and in view with it). */}
      {dependencies}
      {/* Between the links and the idle gaps; only with the timeline (its toggle is the way out of it). */}
      {criticalPath && milestoneCount > 0 && <CriticalChain view={view} />}
      {/* Only with something scheduled: an empty or all-tray project has no span to be idle in. */}
      {view.scheduled.length > 0 && <IdleGaps gaps={view.idleGaps} scope="project" />}

      {editor?.kind === "create" && <MilestoneEditorModal project={project} target={null} onClose={closeEditor} onSaved={saved} />}
      {editor?.kind === "edit" && <MilestoneEditorModal project={project} target={editor.milestone} onClose={closeEditor} onSaved={saved} />}
      {editor?.kind === "project" && (
        <ProjectEditorModal program={{ id: project.programId, name: project.programName }} target={project} onClose={closeEditor} onSaved={saved} />
      )}
      {(editor?.kind === "dependency" || editor?.kind === "editDependency") && (
        <DependencyEditorModal
          project={project}
          milestones={[...view.scheduled, ...view.unscheduled]}
          successor={editor.kind === "dependency" ? editor.successor : null}
          target={editor.kind === "editDependency" ? editor.dependency : null}
          onClose={closeEditor}
          onSaved={saved}
        />
      )}
      {scheduling !== null && (
        <MilestoneScheduleModal
          milestone={scheduling.milestone}
          refused={schedule.refused}
          onSchedule={(start, end) => commitFromDialog(scheduling, start, end)}
          onUnschedule={() => commitFromDialog(scheduling, null, null)}
          onClose={() => setScheduling(null)}
        />
      )}

      <ConfirmDeleteModal
        confirm={removeMilestone}
        title={t("project.milestone.deleteTitle")}
        errorTitle={t("project.milestone.deleteFailed")}
        errorMessage={deleteErrors}
        body={({ milestone, links }) => (
          <>
            {t("project.milestone.deleteBody", { name: milestone.name })}
            {links > 0 && ` ${t("project.dependency.deleteWith", { count: links })}`}
          </>
        )}
      />
      <ConfirmDeleteModal
        confirm={removeProject}
        title={t("project.deleteProject.title")}
        errorTitle={t("project.deleteProject.failed")}
        errorMessage={deleteErrors}
        body={(target) => (
          <>
            {target.milestones === 0
              ? t("project.deleteProject.bodyEmpty", { name: target.name })
              : t("project.deleteProject.body", { name: target.name, count: target.milestones })}
            {target.links > 0 && ` ${t("project.dependency.deleteWith", { count: target.links })}`}
          </>
        )}
      />
    </Stack>
  );
}
