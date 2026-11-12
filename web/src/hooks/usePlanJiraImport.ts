import { useState } from "react";
import type { PlanProgram, PlanView, PlanWorkStream } from "../api/plan";
import { importSourceOf, type ImportRoot, type ImportSource } from "../utils/jiraImport";
import { useJiraConnections, useJiraProgramLinks, type JiraProgramLink } from "./useDeviations";

/** Which Jira import is open: a work stream's whole-scope one (its menu), or the one rooted at a linked program (1.14, its menu). */
type ImportState = { kind: "stream"; stream: PlanWorkStream } | { kind: "program"; stream: PlanWorkStream; program: PlanProgram; link: JiraProgramLink };

/** The rooted dialog's root: the program and its link; the owner opens as the program's own (an active person: one who owns a node cannot be deleted). */
const programRoot = (stream: PlanWorkStream, program: PlanProgram, link: JiraProgramLink): ImportRoot => ({
  level: "PROGRAM",
  nodeId: program.id,
  name: program.name,
  issueKey: link.issueKey,
  connectionId: link.connectionId,
  workStreamId: stream.id,
  owner: { value: String(program.ownerPersonId), label: program.ownerName },
  gone: link.gone,
});

/** The props the Plan page hands `JiraImportModal`. */
type ModalProps = { source: ImportSource; initialWorkStreamId?: number; root?: ImportRoot; onClose: () => void };

/**
 * The Plan page's two Jira imports. A work stream's (1.10) reads the usable connections from the deviations view only after the click. A linked
 * program's (1.14) is rooted: ONE small read of every linked program (`useJiraProgramLinks`) serves the menu entry's visibility AND the dialog's
 * connection, so opening it asks for nothing more; it is asked only while the plan view holds a program the caller may add a project to, and a
 * failed read just leaves the entry out. `modal` (and its `modalKey`, `stream:<id>` / `program:<id>`) is null while no dialog is open.
 */
export function usePlanJiraImport(plan: PlanView | undefined) {
  const [importing, setImporting] = useState<ImportState | null>(null);
  const jira = useJiraConnections({ workStreamId: importing?.stream.id }, importing?.kind === "stream");
  const wantsLinks = plan?.workStreams.some((stream) => stream.programs.some((program) => program.can.createProject)) ?? false;
  const programLinks = useJiraProgramLinks(wantsLinks);
  const close = () => setImporting(null);

  let modal: ModalProps | null = null;
  if (importing?.kind === "stream") modal = { source: importSourceOf(jira), initialWorkStreamId: importing.stream.id, onClose: close };
  if (importing?.kind === "program") modal = { source: importSourceOf(programLinks), root: programRoot(importing.stream, importing.program, importing.link), onClose: close };

  // The modal's `key` follows its source, so its form state (`useState` initialisers) never carries over from one import to another.
  const modalKey = importing === null ? null : `${importing.kind}:${importing.kind === "stream" ? importing.stream.id : importing.program.id}`;

  return {
    modal,
    modalKey,
    importFromJira: (stream: PlanWorkStream) => setImporting({ kind: "stream", stream }),
    importChildren: (stream: PlanWorkStream, program: PlanProgram) => {
      const link = programLinks.links.get(program.id);
      if (link !== undefined) setImporting({ kind: "program", stream, program, link });
    },
    canImportChildren: (program: PlanProgram) => program.can.createProject && programLinks.links.has(program.id),
  };
}
