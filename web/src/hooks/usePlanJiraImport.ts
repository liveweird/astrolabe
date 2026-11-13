import { useState } from "react";
import type { JiraNodeLink } from "../api/jira";
import type { PlanProgram, PlanProject, PlanView, PlanWorkStream } from "../api/plan";
import { importSourceOf, type ImportRoot, type ImportSource } from "../utils/jiraImport";
import { rootOf } from "../utils/jiraImportRoot";
import { useJiraConnections } from "./useDeviations";
import { useJiraPlanLinks } from "./useJiraPlanLinks";

/** Which Jira import is open: a work stream's whole-scope one (its menu), or one rooted at a linked program (1.14) or project (1.15). */
type ImportState =
  | { kind: "stream"; stream: PlanWorkStream }
  | { kind: "program"; program: PlanProgram; link: JiraNodeLink }
  | { kind: "project"; project: PlanProject; link: JiraNodeLink };

const nodeIdOf = (state: ImportState): number => (state.kind === "stream" ? state.stream.id : state.kind === "program" ? state.program.id : state.project.id);

/** The props the Plan page hands `JiraImportModal`. */
type ModalProps = { source: ImportSource; initialWorkStreamId?: number; root?: ImportRoot; onClose: () => void };

/**
 * The Plan page's three Jira imports. A work stream's (1.10) reads the usable connections from the deviations view only after the click. A linked
 * program's (1.14) and a linked project's (1.15) are rooted: ONE small read of every link (`useJiraPlanLinks`) serves the menu entries' visibility
 * AND the dialog's connection, so opening either asks for nothing more; it is asked only while the plan view holds a program the caller may add a
 * project to or a project the caller may add a milestone to, and a failed read just leaves the entries out. `modal` (and its `modalKey`,
 * `stream:<id>` / `program:<id>` / `project:<id>`) is null while no dialog is open.
 */
export function usePlanJiraImport(plan: PlanView | undefined) {
  const [importing, setImporting] = useState<ImportState | null>(null);
  const jira = useJiraConnections({ workStreamId: importing?.kind === "stream" ? importing.stream.id : undefined }, importing?.kind === "stream");
  const wantsLinks =
    plan?.workStreams.some((stream) => stream.programs.some((program) => program.can.createProject || program.projects.some((project) => project.can.createMilestone))) ?? false;
  const links = useJiraPlanLinks(wantsLinks);
  const close = () => setImporting(null);

  let modal: ModalProps | null = null;
  if (importing?.kind === "stream") modal = { source: importSourceOf(jira), initialWorkStreamId: importing.stream.id, onClose: close };
  if (importing?.kind === "program") modal = { source: importSourceOf(links), root: rootOf("PROGRAM", importing.program, importing.link), onClose: close };
  if (importing?.kind === "project") modal = { source: importSourceOf(links), root: rootOf("PROJECT", importing.project, importing.link), onClose: close };

  // The modal's `key` follows its source, so its form state (`useState` initialisers) never carries over from one import to another.
  const modalKey = importing === null ? null : `${importing.kind}:${nodeIdOf(importing)}`;

  return {
    modal,
    modalKey,
    importFromJira: (stream: PlanWorkStream) => setImporting({ kind: "stream", stream }),
    importChildren: (program: PlanProgram) => {
      const link = links.programs.get(program.id);
      if (link !== undefined) setImporting({ kind: "program", program, link });
    },
    canImportChildren: (program: PlanProgram) => program.can.createProject && links.programs.has(program.id),
    importMilestones: (project: PlanProject) => {
      const link = links.projects.get(project.id);
      if (link !== undefined) setImporting({ kind: "project", project, link });
    },
    canImportMilestones: (project: PlanProject) => project.can.createMilestone && links.projects.has(project.id),
  };
}
