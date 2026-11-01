import { useState, type ReactNode } from "react";
import { Button, Group, Modal, NumberInput, SegmentedControl, Select, Stack, Text, TextInput } from "@mantine/core";
import { useForm, type UseFormReturnType } from "@mantine/form";
import { useTranslation } from "react-i18next";
import { createDependency, isDependencyCycle, updateDependency, type EndpointKind, type EndpointRef, type ProjectDependency } from "../api/dependencies";
import {
  cyclePathText,
  DEPENDENCY_TYPES,
  dependencyEditValidation,
  dependencyEndpointText,
  dependencyFormValidation,
  dependencySaveErrorMessage,
  dependencyUpdateErrorMessage,
  editDependencyForm,
  emptyDependencyForm,
  MAX_LAG_DAYS,
  MIN_LAG_DAYS,
  PROJECT_SUCCESSOR,
  toDependencyBody,
  toDependencyUpdateBody,
  type DependencyFormValues,
} from "../utils/dependencyForm";
import { showSuccessToast } from "../utils/toast";
import FormErrorAlert from "./FormErrorAlert";
import MilestoneSelect from "./MilestoneSelect";
import ProjectSelect from "./ProjectSelect";

/** The type and the lag: the two fields both modes edit. */
function TypeAndLagFields({ form }: { form: UseFormReturnType<DependencyFormValues> }) {
  const { t } = useTranslation();
  return (
    <>
      <Select
        label={t("project.dependency.type.label")}
        data={DEPENDENCY_TYPES.map((type) => ({ value: type, label: t(`project.dependency.type.${type}`) }))}
        allowDeselect={false}
        {...form.getInputProps("type")}
      />
      <NumberInput
        label={t("project.dependency.lagLabel")}
        description={t("project.dependency.lagHint")}
        min={MIN_LAG_DAYS}
        max={MAX_LAG_DAYS}
        allowDecimal={false}
        {...form.getInputProps("lagDays")}
      />
    </>
  );
}

/** The cycle 409 as the localized sentence plus the path ("A → B → A"), never the server's text. */
function CycleNotice({ message, path }: { message: string; path: Parameters<typeof cyclePathText>[0] | undefined }) {
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

/**
 * Add a dependency to a project (`POST /projects/{id}/dependencies`): the SUCCESSOR is fixed to this project or one of its
 * milestones (the constrained side - the dialog says so), the predecessor is any milestone or project found by name, then the
 * type and a lag in working days (negative = a lead). Nothing moves: a link that does not hold only warns afterwards. A cycle 409
 * is told apart and drawn with its path ("A → B → A"); the duplicate pair and the rest are inline alerts. `successor` prefills the
 * milestone the row menu was opened on.
 *
 * With `target` it EDITS that link in place (`PUT /dependencies/{id}`): the two ends are read-only fields (changing an end is
 * delete + add), only the type and the lag are editable, and a type that would close a cycle is the same 409 with its path.
 */
export default function DependencyEditorModal({
  project,
  milestones,
  successor,
  target = null,
  onClose,
  onSaved,
}: {
  project: { id: number; name: string };
  /** This project's milestones (scheduled or not): the candidates for the successor. */
  milestones: readonly { id: number; name: string }[];
  successor: EndpointRef | null;
  /** The link to edit; null = add a new one. */
  target?: ProjectDependency | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  const editing = target !== null;
  const form = useForm<DependencyFormValues>({
    initialValues: editing ? editDependencyForm(target) : emptyDependencyForm(successor),
    validate: editing ? dependencyEditValidation(t) : dependencyFormValidation(t, project.id),
  });

  async function save(values: DependencyFormValues) {
    setError(null);
    setSubmitting(true);
    try {
      if (editing) {
        await updateDependency(target.id, toDependencyUpdateBody(values));
      } else {
        await createDependency(project.id, toDependencyBody(values, project.id));
      }
      showSuccessToast(t(editing ? "project.toast.dependencySaved" : "project.toast.dependencyAdded"));
      await onSaved();
    } catch (err) {
      if (isDependencyCycle(err)) {
        setError(<CycleNotice message={t(editing ? "project.dependency.cycleEdit" : "project.dependency.cycle")} path={err.cycle} />);
      } else {
        setError(editing ? dependencyUpdateErrorMessage(err, t) : dependencySaveErrorMessage(err, t));
      }
      setSubmitting(false);
    }
  }

  const successors = [
    { value: PROJECT_SUCCESSOR, label: t("project.dependency.thisProject", { name: project.name }) },
    ...milestones.map((milestone) => ({ value: `milestone:${milestone.id}`, label: milestone.name })),
  ];
  const pickPredecessor = (picked: DependencyFormValues["predecessor"]) => {
    form.setFieldValue("predecessor", picked);
    form.clearFieldError("predecessor");
  };

  return (
    <Modal
      closeButtonProps={{ "aria-label": t("common.action.close") }}
      // While the request is in flight the dialog stays: closing it would hide the outcome (a cycle notice, a refusal) of a save that still lands.
      withCloseButton={!submitting}
      closeOnEscape={!submitting}
      closeOnClickOutside={!submitting}
      opened
      onClose={onClose}
      title={t(editing ? "project.dependency.editTitle" : "project.dependency.createTitle")}
      centered
    >
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          <Text size="sm" c="dimmed">
            {t(editing ? "project.dependency.editIntro" : "project.dependency.intro")}
          </Text>
          {editing ? (
            <>
              <TextInput label={t("project.dependency.predecessor")} value={dependencyEndpointText(target.predecessor, project.id, t)} readOnly />
              <TextInput label={t("project.dependency.successor")} value={dependencyEndpointText(target.successor, project.id, t)} readOnly />
            </>
          ) : (
            <>
              <Select
                label={t("project.dependency.successor")}
                description={t("project.dependency.successorHint")}
                data={successors}
                allowDeselect={false}
                {...form.getInputProps("successor")}
                onChange={(value) => {
                  form.setFieldValue("successor", value ?? PROJECT_SUCCESSOR);
                  form.clearFieldError("predecessor");
                }}
              />
              <SegmentedControl
                fullWidth
                aria-label={t("project.dependency.predecessorKind")}
                data={(["MILESTONE", "PROJECT"] as const).map((kind) => ({ value: kind, label: t(`project.dependency.kind.${kind}`) }))}
                value={form.values.predecessorKind}
                onChange={(value) => {
                  form.setFieldValue("predecessorKind", value as EndpointKind);
                  pickPredecessor(null);
                }}
              />
              {form.values.predecessorKind === "MILESTONE" ? (
                <MilestoneSelect picked={form.values.predecessor} onPick={pickPredecessor} error={form.errors.predecessor} />
              ) : (
                <ProjectSelect picked={form.values.predecessor} onPick={pickPredecessor} error={form.errors.predecessor} />
              )}
            </>
          )}
          <TypeAndLagFields form={form} />
          {error && <FormErrorAlert>{error}</FormErrorAlert>}
          <Group justify="flex-end" gap="sm">
            <Button type="button" variant="default" onClick={onClose} disabled={submitting}>
              {t("common.action.cancel")}
            </Button>
            <Button type="submit" loading={submitting}>
              {t("common.action.save")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
