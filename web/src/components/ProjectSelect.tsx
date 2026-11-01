import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listProjects } from "../api/plan";
import SearchPicker, { type PickedOption } from "./SearchPicker";

/**
 * A searchable, clearable picker over every project (`GET /projects` is open to every signed-in user): the dependency editor's
 * predecessor when the other end is a whole project. An option reads "name · program · work stream", which tells two projects of
 * the same name apart. The caller holds the pick (its label survives later searches).
 */
export default function ProjectSelect({
  picked,
  onPick,
  error,
}: {
  picked: PickedOption | null;
  onPick: (picked: PickedOption | null) => void;
  /** A field error (a validation the form maps onto this control). */
  error?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <SearchPicker
      label={t("project.dependency.predecessor")}
      description={t("project.dependency.predecessorHint")}
      placeholder={t("project.dependency.pickProject")}
      clearLabel={t("project.dependency.clearProject")}
      noMatchLabel={t("project.dependency.noMatchingProjects")}
      queryKey={["plan", "projects", "picker"]}
      search={async (term) => {
        const page = await listProjects({ page: 1, pageSize: 50, sort: "name", name: term || undefined });
        return page.items.map((project) => ({ value: String(project.id), label: `${project.name} · ${project.programName} · ${project.workStreamName}` }));
      }}
      picked={picked}
      onPick={onPick}
      error={error}
    />
  );
}
