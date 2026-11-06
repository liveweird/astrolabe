import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { getPlanView } from "../api/plan";
import type { JiraLevel } from "../api/jira";
import MilestoneSelect from "./MilestoneSelect";
import ProjectSelect from "./ProjectSelect";
import type { PickedOption } from "./SearchPicker";

/**
 * Programs have no paged list (the plan view is their read surface, ~20 of them): a searchable `Select` over `GET /views/plan`, only the
 * programs the viewer may link (the view's own `can.edit` = the owner chain or ADMIN, the bind's guard). Shares the plan page's cache entry.
 */
function ProgramPick({ picked, onPick, error }: { picked: PickedOption | null; onPick: (picked: PickedOption | null) => void; error?: ReactNode }) {
  const { t } = useTranslation();
  const plan = useQuery({ queryKey: ["plan", "view"], queryFn: getPlanView });
  const options = (plan.data?.workStreams ?? []).flatMap((stream) =>
    stream.programs.filter((program) => program.can.edit).map((program) => ({ value: String(program.id), label: t("jira.bind.programOption", { name: program.name, workStream: stream.name }) })),
  );
  return (
    <Select
      label={t("jira.bind.program")}
      description={t("jira.bind.pickHint")}
      placeholder={t("jira.bind.pickProgram")}
      data={options}
      searchable
      clearable
      clearButtonProps={{ "aria-label": t("jira.bind.clearProgram") }}
      nothingFoundMessage={plan.isLoading ? undefined : t("jira.bind.noMatchingPrograms")}
      value={picked?.value ?? null}
      onChange={(value) => onPick(value === null ? null : { value, label: options.find((option) => option.value === value)?.label ?? value })}
      error={error ?? (plan.isError ? t("jira.bind.loadFailed") : undefined)}
      aria-busy={plan.isLoading}
    />
  );
}

/**
 * The plan-item picker of the bind dialog by level: a program from the plan view, a project or a milestone through the dependency
 * editor's paged pickers (`GET /projects`, `GET /milestones` with `name`) under this dialog's own words.
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
  if (level === "PROGRAM") return <ProgramPick picked={picked} onPick={onPick} error={error} />;
  if (level === "PROJECT") return <ProjectSelect label={t("jira.mapping.level.project")} description={hint} picked={picked} onPick={onPick} error={error} />;
  return <MilestoneSelect label={t("jira.mapping.level.milestone")} description={hint} picked={picked} onPick={onPick} error={error} />;
}
