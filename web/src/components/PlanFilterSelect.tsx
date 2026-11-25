import { useTranslation } from "react-i18next";
import { Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { getPlanView, planViewKey } from "../api/plan";
import { programOptions, projectOptions, workStreamOptions, type PlanLevel, type PlanScope } from "../utils/planNames";

const OPTIONS = { workStream: workStreamOptions, program: programOptions, project: projectOptions } as const;

// The words of each level: the field's label, its clear button and the option a link's id gets when the settled plan does not hold it.
const WORDS = {
  workStream: { label: "deviations.filter.workStream", clear: "deviations.filter.clearWorkStream", unknown: "deviations.filter.workStreamUnknown" },
  program: { label: "common.filter.program", clear: "common.filter.clearProgram", unknown: "deviations.filter.programUnknown" },
  project: { label: "common.filter.project", clear: "common.filter.clearProject", unknown: "deviations.filter.projectUnknown" },
} as const;

/**
 * The work stream, program or project select of the list pages' filter panels (`level`; Milestones has all three, Dependencies the project one): every
 * node of that level in the plan view (the chip's and the Plan page's cache entry, read when the panel is open - its fields mount only then),
 * searchable and clearable, `undefined` = any. `within` narrows the options to the nodes under a work stream and/or program (a program select
 * within a work stream, a project select within either); the labels do not change with it. Two nodes of one name are told apart by their parent. A
 * value the options do not hold is still shown: by its own label when the plan holds it outside `within` (a link can say so), otherwise as "Project 12"
 * (the chip's words); while the plan has not answered or failed there is no such option, so nothing is claimed from data that has not arrived.
 */
export default function PlanFilterSelect({
  level,
  value,
  onChange,
  within,
}: {
  level: PlanLevel;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  within?: PlanScope;
}) {
  const { t } = useTranslation();
  const plan = useQuery({ queryKey: planViewKey, queryFn: getPlanView });
  const words = WORDS[level];
  const data = OPTIONS[level](plan.data, within).map((option) => ({ value: String(option.id), label: option.label }));
  if (value !== undefined && plan.data !== undefined && !data.some((option) => option.value === String(value))) {
    const held = OPTIONS[level](plan.data).find((option) => option.id === value);
    data.push({ value: String(value), label: held?.label ?? t(words.unknown, { id: value }) });
  }
  return (
    <Select
      label={t(words.label)}
      placeholder={t("common.state.any")}
      data={data}
      value={value === undefined ? null : String(value)}
      onChange={(selected) => onChange(selected === null ? undefined : Number(selected))}
      searchable
      clearable
      clearButtonProps={{ "aria-label": t(words.clear) }}
    />
  );
}
