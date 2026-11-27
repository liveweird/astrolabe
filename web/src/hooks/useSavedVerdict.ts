import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { ApiError } from "../api/http";
import { getSavedProposal, savedProposalKey } from "../api/savedProposals";
import { idOf } from "../utils/deviationFilters";
import { PROPOSAL_PARAM, withoutProposal } from "../utils/savedProposal";
import { loadErrorMessage } from "../utils/saveError";

/** A saved proposal the address named but that does not open: said in words (visible and dismissible, and said once through the page's polite region). */
export type SavedNotice = { kind: "gone" | "unreadable" | "failed"; text: string };

/**
 * What the Roadmap overview's address (`?proposal=<id>`, 1.33) names, read from the server: the record, and the verdict when it does not open - a 404 (deleted, or pruned by the
 * 21st save) drops the cached copy, an `UNREADABLE` one (saved in a shape this server no longer reads), a malformed id, any other failure worded by its status. Each verdict is
 * said once (`announce`), leaves the address (`replace`) and stays visible as `notice` until dismissed. `beforeDrop` runs once per verdict, before the parameter leaves
 * (`useSavedRun` closes the run the address had opened). Shared by the run (`useSavedRun`) and by an overview with no work streams, which has no run to open but must say the same.
 */
export function useSavedVerdict(announce: (text: string) => void, beforeDrop?: () => void) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const raw = params.get(PROPOSAL_PARAM);
  const id = idOf(raw) ?? null;
  const query = useQuery({ queryKey: savedProposalKey(id ?? 0), queryFn: () => getSavedProposal(id ?? 0), enabled: id !== null });
  const { data, error } = query;
  // A 404 beats the copy kept from before: a gone proposal is never shown, never acceptable.
  const gone = raw !== null && (id === null || (error instanceof ApiError && error.status === 404));
  const record = id === null || gone ? undefined : data;
  const failed = raw !== null && !gone && data === undefined && query.isError;
  const verdict: SavedNotice | null = gone
    ? { kind: "gone", text: t("scheduleProposals.saved.notFound") }
    : failed
      ? { kind: "failed", text: loadErrorMessage(error, t) }
      : record?.state === "UNREADABLE"
        ? { kind: "unreadable", text: t("programs.saved.unreadable", { name: record.name }) }
        : null;
  // The notice outlives the parameter (it leaves the address at once): adjusted during render, dismissed by the viewer. The parameter leaves in a router transition, so
  // a Dismiss can land while the address still names the proposal: the dismissed address is remembered and its verdict not shown again, until the parameter has left
  // (an address that names a proposal again, the same or another, says its verdict again).
  const [notice, setNotice] = useState<SavedNotice | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (raw === null && dismissed !== null) setDismissed(null);
  if (verdict !== null && raw !== dismissed && (notice?.kind !== verdict.kind || notice.text !== verdict.text)) setNotice(verdict);

  const drop = () => setParams((current) => withoutProposal(current), { replace: true });
  // What each effect has already done for the address it saw (a step that touches the address or the page's status region must not repeat while the address catches up).
  const handled = useRef(new Set<string>());
  useEffect(() => {
    if (raw === null) handled.current.clear();
  });
  useEffect(() => {
    if (verdict === null || handled.current.has(`verdict:${raw}`)) return;
    handled.current.add(`verdict:${raw}`);
    if (id !== null && gone) queryClient.removeQueries({ queryKey: savedProposalKey(id) });
    beforeDrop?.();
    announce(verdict.text);
    drop();
  });
  const dismissNotice = () => {
    setNotice(null);
    setDismissed(raw);
  };
  return { raw, id, record, verdict, notice, dismissNotice, drop, handled };
}
