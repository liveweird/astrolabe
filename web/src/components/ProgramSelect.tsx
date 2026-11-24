import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listPrograms } from "../api/plan";
import { OPTION_PAGE_SIZE } from "../hooks/usePagedSort";
import SearchPicker, { type PickedOption } from "./SearchPicker";

/**
 * A searchable, clearable picker over every program (`GET /programs` is open to every signed-in user): the Jira bind dialog's plan
 * item at the program level. An option reads "name · work stream", which tells two programs of the same name apart. The caller holds
 * the pick (its label survives later searches).
 */
export default function ProgramSelect({
  picked,
  onPick,
  error,
}: {
  picked: PickedOption | null;
  onPick: (picked: PickedOption | null) => void;
  /** A field error (a validation or a server answer the form maps onto this control). */
  error?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <SearchPicker
      label={t("jira.bind.program")}
      description={t("jira.bind.pickHint")}
      placeholder={t("jira.bind.pickProgram")}
      clearLabel={t("jira.bind.clearProgram")}
      noMatchLabel={t("jira.bind.noMatchingPrograms")}
      queryKey={["plan", "programs", "picker"]}
      search={async (term) => {
        const page = await listPrograms({ page: 1, pageSize: OPTION_PAGE_SIZE, sort: "name", name: term || undefined });
        return page.items.map((program) => ({ value: String(program.id), label: `${program.name} · ${program.workStreamName}` }));
      }}
      picked={picked}
      onPick={onPick}
      error={error}
    />
  );
}
