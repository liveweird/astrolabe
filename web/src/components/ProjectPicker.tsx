import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Select } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { getPlanView, planViewKey } from "../api/plan";
import { projectPath } from "../utils/planLinks";
import { projectOptionsFilter, projectPickerOptions } from "../utils/projectPicker";

/**
 * The project picker (1.29): a searchable `Select` over the cached plan view, the one way between projects. Options are grouped "Work stream › Program"
 * (a closed work stream is marked), and the search matches the project, program, work stream and owner names, accents folded. It is never clearable
 * (a project page always has a project; the bare `/projects` shows none until one is picked) and a pick is a push to the project's page, so Back returns.
 * `projectId` is the project shown (`null` = none); `currentName` names it for a page whose plan view has not answered or does not hold it.
 * The control has no visible label (it sits where the back link was): its accessible name is the plain noun, never "… picker" (the role says that).
 */
export default function ProjectPicker({ projectId, currentName }: { projectId: number | null; currentName?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const plan = useQuery({ queryKey: planViewKey, queryFn: getPlanView });
  const closedMark = t("project.picker.closedStream");
  const data = useMemo(
    () => projectPickerOptions(plan.data, closedMark, projectId !== null && currentName !== undefined ? { id: projectId, name: currentName } : undefined),
    [plan.data, closedMark, projectId, currentName],
  );
  return (
    <Select
      aria-label={t("common.filter.project")}
      placeholder={t("project.picker.placeholder")}
      data={data}
      value={projectId === null ? null : String(projectId)}
      onChange={(picked) => {
        if (picked !== null && Number(picked) !== projectId) navigate(projectPath(Number(picked)));
      }}
      filter={projectOptionsFilter}
      nothingFoundMessage={t("project.picker.nothingFound")}
      searchable
      clearable={false}
      allowDeselect={false}
      w={360}
      maw="100%"
    />
  );
}
