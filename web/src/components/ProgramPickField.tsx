import { MultiSelect } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { ProgramOption } from "../utils/roadmapRows";

/**
 * The program pick ("which programs am I looking at"): a multi-select over the programs of the page's view, empty = every program. The same field
 * serves the roadmap and the programs page - the stored value is ONE key (`hooks/useProgramPick.ts`), so a pick made on one page is in force on
 * the other. A program name two work streams share is told apart by its stream.
 */
export default function ProgramPickField({ programs, pick, onPick }: { programs: readonly ProgramOption[]; pick: readonly number[]; onPick: (ids: number[]) => void }) {
  const { t } = useTranslation();
  const sameName = (name: string) => programs.filter((program) => program.name === name).length > 1;
  return (
    <MultiSelect
      label={t("common.filter.programs")}
      placeholder={pick.length === 0 ? t("common.filter.allPrograms") : undefined}
      data={programs.map((program) => ({ value: String(program.id), label: sameName(program.name) ? `${program.name} (${program.workStreamName})` : program.name }))}
      value={pick.map(String)}
      onChange={(values) => onPick(values.map(Number))}
      searchable
      clearable
      clearButtonProps={{ "aria-label": t("common.filter.clearPrograms") }}
      miw={220}
    />
  );
}
