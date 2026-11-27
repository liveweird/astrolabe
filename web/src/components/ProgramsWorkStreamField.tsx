import { Select } from "@mantine/core";
import { useTranslation } from "react-i18next";

/** The overview's work stream field (1.31), beside the program pick in the filter panel: one work stream or none (the whole plan); the state is the address's alone (`useWorkStreamNarrowing`). */
export default function ProgramsWorkStreamField({ workStreams, value, onChange }: { workStreams: readonly { id: number; name: string }[]; value: number | null; onChange: (id: number | null) => void }) {
  const { t } = useTranslation();
  return (
    <Select
      label={t("roadmap.filter.workStream")}
      placeholder={t("common.state.any")}
      data={workStreams.map((stream) => ({ value: String(stream.id), label: stream.name }))}
      value={value === null ? null : String(value)}
      onChange={(next) => onChange(next === null ? null : Number(next))}
      searchable
      clearable
      clearButtonProps={{ "aria-label": t("roadmap.filter.clearWorkStream") }}
    />
  );
}
