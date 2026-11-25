import type { ReactNode } from "react";
import { NumberInput, SegmentedControl, Select, Stack, Text } from "@mantine/core";
import type { UseFormReturnType } from "@mantine/form";
import { useTranslation } from "react-i18next";
import type { EndpointKind } from "../api/dependencies";
import { cyclePathText, DEPENDENCY_TYPES, MAX_LAG_DAYS, MIN_LAG_DAYS, type DependencyFormValues } from "../utils/dependencyForm";
import MilestoneSelect from "./MilestoneSelect";
import type { PickedOption } from "./SearchPicker";
import ProjectSelect from "./ProjectSelect";

/** What a form's `getInputProps` answers: the Type and Lag fields take theirs from either dependency form (the project page's, the Dependencies page's). */
type InputProps = ReturnType<UseFormReturnType<DependencyFormValues>["getInputProps"]>;

/** The type and the lag: the two fields every mode of the dependency forms has. */
export function TypeAndLagFields({ typeProps, lagProps }: { typeProps: InputProps; lagProps: InputProps }) {
  const { t } = useTranslation();
  return (
    <>
      <Select
        label={t("project.dependency.type.label")}
        data={DEPENDENCY_TYPES.map((type) => ({ value: type, label: t(`project.dependency.type.${type}`) }))}
        allowDeselect={false}
        {...typeProps}
      />
      <NumberInput
        label={t("project.dependency.lagLabel")}
        description={t("project.dependency.lagHint")}
        min={MIN_LAG_DAYS}
        max={MAX_LAG_DAYS}
        allowDecimal={false}
        {...lagProps}
      />
    </>
  );
}

/** The cycle 409 as the localized sentence plus the path ("A → B → A"), never the server's text. */
export function CycleNotice({ message, path }: { message: string; path: Parameters<typeof cyclePathText>[0] | undefined }) {
  return (
    <Stack gap={2}>
      <Text size="sm">{message}</Text>
      {path !== undefined && path.length > 0 && (
        <Text size="sm" fw={600}>
          {cyclePathText(path)}
        </Text>
      )}
    </Stack>
  );
}

/** The predecessor: its kind (a milestone or a whole project), then the picker of that kind over the WHOLE plan. A kind change empties the pick. */
export function PredecessorFields({
  kind,
  picked,
  error,
  onKind,
  onPick,
}: {
  kind: EndpointKind;
  picked: PickedOption | null;
  error?: ReactNode;
  onKind: (kind: EndpointKind) => void;
  onPick: (picked: PickedOption | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <SegmentedControl
        fullWidth
        aria-label={t("project.dependency.predecessorKind")}
        data={(["MILESTONE", "PROJECT"] as const).map((value) => ({ value, label: t(`project.dependency.kind.${value}`) }))}
        value={kind}
        onChange={(value) => onKind(value as EndpointKind)}
      />
      {kind === "MILESTONE" ? <MilestoneSelect picked={picked} onPick={onPick} error={error} /> : <ProjectSelect picked={picked} onPick={onPick} error={error} />}
    </>
  );
}
