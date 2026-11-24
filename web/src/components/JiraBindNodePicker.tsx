import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { JiraLevel } from "../api/jira";
import MilestoneSelect from "./MilestoneSelect";
import ProgramSelect from "./ProgramSelect";
import ProjectSelect from "./ProjectSelect";
import type { PickedOption } from "./SearchPicker";

/**
 * The plan-item picker of the bind dialog by level: a program, a project or a milestone through paged server-side name searches
 * (`GET /programs`, `GET /projects`, `GET /milestones`) under this dialog's own words. The lists are open to every signed-in user, so a node the
 * viewer may not link is offered too and the server's 403 reaches the dialog inline (`can.edit` is the bind's guard).
 */
export default function JiraBindNodePicker({
  level,
  picked,
  onPick,
  error,
}: {
  level: JiraLevel;
  picked: PickedOption | null;
  onPick: (picked: PickedOption | null) => void;
  error?: ReactNode;
}) {
  const { t } = useTranslation();
  const hint = t("jira.bind.pickHint");
  if (level === "PROGRAM") return <ProgramSelect picked={picked} onPick={onPick} error={error} />;
  if (level === "PROJECT") return <ProjectSelect label={t("jira.mapping.level.project")} description={hint} picked={picked} onPick={onPick} error={error} />;
  return <MilestoneSelect label={t("jira.mapping.level.milestone")} description={hint} picked={picked} onPick={onPick} error={error} />;
}
