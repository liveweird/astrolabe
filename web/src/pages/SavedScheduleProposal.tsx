import { Fragment, useEffect, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, Button, Group, Stack, VisuallyHidden } from "@mantine/core";
import { IconCheck, IconWand, IconX } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/http";
import { getSavedProposal, savedProposalKey, type SavedProposalRecord } from "../api/savedProposals";
import CrossTeamRunView from "../components/CrossTeamRunView";
import EditPageLoadState from "../components/EditPageLoadState";
import EntityLink from "../components/EntityLink";
import EntitySentence from "../components/EntitySentence";
import FormErrorAlert from "../components/FormErrorAlert";
import PageHeader from "../components/PageHeader";
import SavedProposalState from "../components/SavedProposalState";
import ProposalNotes from "../components/TeamProposalNotes";
import { movesOf, useCrossTeamProposal } from "../hooks/useCrossTeamProposal";
import { useProposalFocus } from "../hooks/useProposalFocus";
import { useScheduleCheck } from "../hooks/useScheduleCheck";
import { useStatusAnnouncer } from "../hooks/useStatusAnnouncer";
import { refOf } from "../utils/entityLinks";
import { formatDateTime } from "../utils/formatDate";
import { localIsoDate } from "../utils/isoDate";
import { loadErrorMessage } from "../utils/saveError";
import { sameIds, sameRun, storedCheckState } from "../utils/savedProposal";
import { scheduleProposalsPath } from "../utils/scheduleProposalLinks";

const MAX_INT32 = 2_147_483_647;

/** A saved proposal's id as the server has it: 1..2^31-1 in plain digits, nothing else. */
function parseId(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id <= MAX_INT32 ? id : null;
}

/**
 * A saved cross-team proposal (`/schedule-proposals/saved/:id`, 1.26, any signed-in user): what a manager computed and saved, opened by a
 * second one. The server's own stored run and check are shown as they are, never recomputed: the state badge says whether the plan still
 * matches (`CURRENT`) or moved (`CHANGED`, `UNREADABLE` when stored in a shape this server no longer reads), the sections are the cross-team
 * page's. Where `can.accept` holds (ADMIN or the manager of every team, while `CURRENT`) the stored run opens as the cross-team page's own
 * preview: the ticks are editable, the stored check describes the stored ticks (a changed selection asks the server's live check) and
 * Accept is the UNCHANGED accept, which re-checks everything. Otherwise the ticks are read-only. "Propose again" asks for the same teams
 * again with the ticks kept; its fresh run is the page's own preview, not the saved one.
 */
export default function SavedScheduleProposal() {
  const { t } = useTranslation();
  const id = parseId(useParams().id ?? "");
  if (id === null) return <LoadFailure message={t("scheduleProposals.saved.notFound")} />;
  return <Loaded key={id} id={id} />;
}

function LoadFailure({ message, loading = false }: { message: string; loading?: boolean }) {
  const { t } = useTranslation();
  return <EditPageLoadState isLoading={loading} message={message} backTo={scheduleProposalsPath} backLabel={t("scheduleProposals.saved.back")} title={t("scheduleProposals.saved.pageTitle")} />;
}

function Loaded({ id }: { id: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: savedProposalKey(id), queryFn: () => getSavedProposal(id) });
  // A 404 (deleted, or pruned by the 21st save) beats the copy kept from before: a gone proposal is never shown, never acceptable, and not remembered.
  const gone = error instanceof ApiError && error.status === 404;
  useEffect(() => {
    if (gone) queryClient.removeQueries({ queryKey: savedProposalKey(id) });
  }, [gone, id, queryClient]);
  if (gone) return <LoadFailure message={t("scheduleProposals.saved.notFound")} />;
  if (data) return <SavedBody record={data} />;
  return <LoadFailure loading={isLoading} message={loadErrorMessage(error, t)} />;
}

function SavedBody({ record }: { record: SavedProposalRecord }) {
  const { t } = useTranslation();
  const [announcement, announce] = useStatusAnnouncer();
  const flow = useCrossTeamProposal(announce);
  const stored = record.proposal;
  // The stored run opens ONCE as the preview (a viewer who may accept); Discard of a fresh run re-arms it, an accept never does.
  const offered = useRef(false);
  const { open } = flow;
  // `can.accept` weighs the plan, not the day: a run computed for an earlier day may start its moves in the past, so only today's is acceptable.
  // It is also only offered while CURRENT: a refetch that turns the record CHANGED takes the live Accept away.
  const today = localIsoDate();
  const outdated = stored !== null && stored.asOf !== today;
  const acceptable = record.can.accept && record.state === "CURRENT" && !outdated;
  useEffect(() => {
    if (offered.current || !acceptable || stored === null) return;
    if (open(stored, new Set(record.selectedMilestoneIds))) offered.current = true;
  }, [acceptable, open, record.selectedMilestoneIds, stored]);

  const preview = flow.proposal;
  const run = preview ?? stored;
  const fresh = preview !== null && (stored === null || !sameRun(preview, stored));
  // A fresh run is the viewer's own; the stored one is editable only while it may still be accepted.
  const editable = preview !== null && (fresh || acceptable);
  const storedIds = useMemo(() => new Set(record.selectedMilestoneIds), [record.selectedMilestoneIds]);
  const ticked = editable ? flow.selected : storedIds;
  // The stored check describes the stored ticks of the stored run; any other selection (or a fresh run) is asked of the server live.
  const live = editable && (fresh || !sameIds(flow.selected, record.selectedMilestoneIds));
  const liveCheck = useScheduleCheck({
    teamIds: run?.teams.map((team) => team.teamId) ?? [],
    revision: run?.revision ?? 0,
    scopeHash: run?.scopeHash ?? "",
    moves: movesOf(run),
    selected: flow.selected,
    enabled: live,
  });
  const check = live ? liveCheck : storedCheckState(record);
  const busy = flow.requesting || flow.applying;
  const { proposeRef, discardRef } = useProposalFocus(flow, preview, busy);
  // The accept button was the focus and is disabled while the write runs, so a failure would leave the focus on the body: it goes to the alert.
  const errorRef = useRef<HTMLDivElement>(null);
  const { error } = flow;
  useEffect(() => {
    if (error && preview !== null) errorRef.current?.focus();
  }, [error, preview]);

  const by = record.createdBy;
  // A team, project or milestone named in a stored run may be gone once the plan has moved (`CHANGED`): the names are links only while the plan still matches.
  const planMatches = record.state === "CURRENT";
  const teamLinks = record.teams.map((team, index) => (
    <Fragment key={team.id}>
      {index > 0 && ", "}
      <EntityLink entity={{ kind: "team", id: team.id }} name={team.name} current={!planMatches} />
    </Fragment>
  ));
  const facts = (
    <EntitySentence
      text={(marks) =>
        t(by === null ? "scheduleProposals.saved.factsAnonymous" : "scheduleProposals.saved.facts", {
          name: marks.by,
          when: formatDateTime(record.createdAt),
          asOf: record.asOf,
          teams: marks.teams,
          selected: record.selectedCount,
          total: record.moveCount,
          revision: record.planRevision,
        })
      }
      slots={{ by: by === null ? "" : <EntityLink entity={refOf("person", by.personId)} name={by.name} />, teams: teamLinks }}
    />
  );
  const discard = () => {
    if (flow.discard()) offered.current = false;
  };

  return (
    <Stack gap="md">
      <PageHeader
        title={record.name}
        description={facts}
        backTo={{ to: scheduleProposalsPath, label: t("scheduleProposals.saved.back") }}
        actions={
          // The right to run every stored team is the right to delete the proposal (`PlanPermissions`: ADMIN or the manager of every team).
          record.can.delete && (
            <Button
              ref={proposeRef}
              leftSection={<IconWand size={16} />}
              loading={flow.requesting}
              disabled={busy}
              onClick={() => flow.proposeAgain(record.teams.map((team) => team.id), ticked, record.state === "CHANGED")}
            >
              {t("scheduleProposals.saved.proposeAgain")}
            </Button>
          )
        }
      />
      <SavedProposalState record={record} fresh={fresh} outdated={outdated} editable={editable} />
      {flow.refused && (
        <Alert color="orange" variant="light" role="note">
          {t("project.busy")}
        </Alert>
      )}
      <ProposalNotes proposal={flow} />
      {run !== null && (
        <Stack gap="lg">
          <CrossTeamRunView run={run} check={check} selected={ticked} applying={!editable || flow.applying} onToggle={flow.toggle} onSelectAll={flow.selectAll} onSelectNone={flow.selectNone} live={planMatches} />
          {editable && (
            <>
              {error && (
                <FormErrorAlert ref={errorRef} tabIndex={-1}>
                  {error}
                </FormErrorAlert>
              )}
              <Group gap="sm">
                <Button leftSection={<IconCheck size={16} />} loading={flow.applying} disabled={flow.selected.size === 0 || busy} onClick={flow.accept}>
                  {t("scheduleProposals.accept", { count: flow.selected.size })}
                </Button>
                {fresh && (
                  <Button ref={discardRef} variant="default" leftSection={<IconX size={16} />} disabled={flow.applying} onClick={discard}>
                    {t("teams.proposal.discard")}
                  </Button>
                )}
              </Group>
            </>
          )}
        </Stack>
      )}
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>
    </Stack>
  );
}
