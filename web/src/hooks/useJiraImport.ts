import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  applyJiraImport,
  IMPORT_TIMEOUT_MS,
  previewJiraImport,
  type JiraImportApplyRequest,
  type JiraImportPreview,
  type JiraImportResult,
  type JiraImportScope,
} from "../api/jira";
import { applyMayHaveLanded, importFailure, type ImportFailure } from "../utils/jiraImportText";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";

export type ImportPhase = "scope" | "preview" | "outcome";
type Busy = "preview" | "apply" | null;

/** The preview with the exact scope it was read under: the apply sends THAT scope, never the form's current (possibly edited) one. */
export type PreviewState = { scope: JiraImportScope; data: JiraImportPreview };

/**
 * The import modal's three phases and its two calls. One request at a time (`inFlight` is a ref, so a double click in the same tick is
 * refused too); each call owns an AbortController that aborts at `IMPORT_TIMEOUT_MS` (a browse can take the server 170 s) and, for the
 * PREVIEW only, when the user cancels or the modal unmounts - an apply is never cancelled by the client (it may already be writing).
 * After an apply the plan views and the Jira queries are refreshed - also after an answer that leaves the write in doubt (`applyMayHaveLanded`).
 * `connectionId` is null until the modal has a connection (the Plan page's list arrives asynchronously, or several are offered): both calls then do nothing.
 */
export function useJiraImport(connectionId: number | null) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<ImportPhase>("scope");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  // Counts the previews that were set (two can share an `asOf`): the preview step is keyed by it, so every new preview starts the step afresh.
  const [previewSeq, setPreviewSeq] = useState(0);
  const [result, setResult] = useState<JiraImportResult | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<ImportFailure | null>(null);
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const cancelling = useRef(false);
  const inFlightKind = useRef<"preview" | "apply" | null>(null);

  // Leaving the page cancels a PREVIEW (a read) only. An APPLY is never aborted by the client: it may be writing, so it runs to its end and
  // still refreshes the plan (below), whoever is still looking at it.
  useEffect(
    () => () => {
      if (inFlightKind.current === "preview") controller.current?.abort();
    },
    [],
  );

  async function guarded<T>(kind: "preview" | "apply", call: (signal: AbortSignal) => Promise<T>, onValue: (value: T) => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    inFlightKind.current = kind;
    cancelling.current = false;
    const own = new AbortController();
    controller.current = own;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      own.abort();
    }, IMPORT_TIMEOUT_MS);
    setBusy(kind);
    setFailure(null);
    try {
      onValue(await call(own.signal));
    } catch (err) {
      setFailure(importFailure(err, t, { apply: kind === "apply", timedOut, cancelled: cancelling.current && !timedOut }));
      if (kind === "apply" && applyMayHaveLanded(err, timedOut)) void refreshAfterApply();
    } finally {
      clearTimeout(timer);
      controller.current = null;
      inFlight.current = false;
      inFlightKind.current = null;
      setBusy(null);
    }
  }

  function refreshAfterApply() {
    return refreshQueriesAfterMutation(queryClient, ["jira"], ["plan"], ["roadmap"]);
  }

  return {
    phase,
    preview,
    previewSeq,
    result,
    busy,
    failure,
    /** Reads Jira and moves to (or stays on) the preview. */
    runPreview: (scope: JiraImportScope) =>
      connectionId === null ? Promise.resolve() : guarded(
        "preview",
        (signal) => previewJiraImport(connectionId, scope, signal),
        (data) => {
          setPreview({ scope, data });
          setPreviewSeq((count) => count + 1);
          setResult(null);
          setPhase("preview");
        },
      ),
    /** Writes the ticked rows; the outcome is the next phase. */
    runApply: (body: JiraImportApplyRequest) =>
      connectionId === null ? Promise.resolve() : guarded(
        "apply",
        (signal) => applyJiraImport(connectionId, body, signal),
        (value) => {
          setResult(value);
          setPhase("outcome");
          void refreshAfterApply();
        },
      ),
    /** Stops a preview that is still reading Jira. */
    cancelPreview: () => {
      cancelling.current = true;
      controller.current?.abort();
    },
    back: () => {
      setFailure(null);
      setPhase("scope");
    },
  };
}
