import { useState, type ReactNode } from "react";
import { Button, Group, Modal, SegmentedControl, Select, Stack, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import { createDependency, isDependencyCycle, type EndpointKind } from "../api/dependencies";
import {
  dependencyAddValidation,
  dependencySaveErrorMessage,
  emptyDependencyAddForm,
  toDependencyAddRequest,
  type DependencyAddValues,
} from "../utils/dependencyForm";
import { showSuccessToast } from "../utils/toast";
import { CycleNotice, PredecessorFields, TypeAndLagFields } from "./DependencyFormParts";
import FormErrorAlert from "./FormErrorAlert";
import MilestoneSelect from "./MilestoneSelect";

/**
 * Add a dependency from the dependency panel (1.27; `POST /projects/{id}/dependencies`, the same write as the project page's dialog): there is no
 * own project here, so the first field picks the SUCCESSOR's project, from `projects` only (the ones the plan view says the caller may add to,
 * `can.createDependency`; the server's guard still decides). The successor is then one of that project's milestones (a picker limited to it) or the
 * whole project; the predecessor is anything in the plan, found by name as on the project page; then the type and the lag. Nothing moves: a link that
 * does not hold only warns afterwards. A cycle 409 is told apart and drawn with its path, the duplicate pair and the other refusals stay in the
 * dialog as an alert. Changing the project empties the successor picked for the one before. While the request is in flight the dialog cannot be
 * closed (the close button, Escape, a click outside and Cancel are off), so the outcome of a save that still lands is never hidden.
 */
export default function DependencyAddModal({
  projects,
  initialProjectId,
  onClose,
  onSaved,
}: {
  /** The projects the caller may add a dependency to, labelled. */
  projects: readonly { id: number; label: string }[];
  /** The project to start on (the page's project filter), or `null`; ignored when the caller may not add to it. */
  initialProjectId: number | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  const form = useForm<DependencyAddValues>({
    initialValues: emptyDependencyAddForm(projects.some((project) => project.id === initialProjectId) ? initialProjectId : null),
    validate: dependencyAddValidation(t),
  });
  // Fixed at mount (Mantine's focus trap reads `data-autofocus` once, when the dialog opens): with a project given, the first empty field is the successor.
  const [startsOnProject] = useState(() => form.values.projectId !== null);

  async function save(values: DependencyAddValues) {
    setError(null);
    setSubmitting(true);
    try {
      const request = toDependencyAddRequest(values);
      await createDependency(request.projectId, request.body);
      showSuccessToast(t("project.toast.dependencyAdded"));
      await onSaved();
    } catch (err) {
      if (isDependencyCycle(err)) {
        setError(<CycleNotice message={t("project.dependency.cycle")} path={err.cycle} />);
      } else {
        setError(dependencySaveErrorMessage(err, t));
      }
      setSubmitting(false);
    }
  }

  // A pick of the successor changes what the predecessor may not be (itself), so its message goes stale.
  const changeSuccessor = (patch: Partial<DependencyAddValues>) => {
    form.setValues(patch);
    form.clearFieldError("successor");
    form.clearFieldError("predecessor");
  };
  const pickPredecessor = (picked: DependencyAddValues["predecessor"]) => {
    form.setFieldValue("predecessor", picked);
    form.clearFieldError("predecessor");
  };
  const projectId = form.values.projectId === null ? undefined : Number(form.values.projectId);

  return (
    <Modal
      closeButtonProps={{ "aria-label": t("common.action.close") }}
      // While the request is in flight the dialog stays: closing it would hide the outcome (a cycle notice, a refusal) of a save that still lands.
      withCloseButton={!submitting}
      closeOnEscape={!submitting}
      closeOnClickOutside={!submitting}
      opened
      onClose={onClose}
      title={t("project.dependency.createTitle")}
      centered
    >
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          <Text size="sm" c="dimmed">
            {t("project.dependency.intro")}
          </Text>
          <Select
            // The dialog opens on the first field still empty: the project, or (a project given) the successor milestone below.
            data-autofocus={!startsOnProject || undefined}
            label={t("dependencyList.add.successorProject")}
            description={t("dependencyList.add.successorProjectHint")}
            placeholder={t("project.dependency.pickProject")}
            data={projects.map((project) => ({ value: String(project.id), label: project.label }))}
            searchable
            allowDeselect={false}
            nothingFoundMessage={t("project.dependency.noMatchingProjects")}
            {...form.getInputProps("projectId")}
            onChange={(value) => {
              changeSuccessor({ projectId: value, successor: null });
              form.clearFieldError("projectId");
            }}
          />
          <SegmentedControl
            fullWidth
            aria-label={t("dependencyList.add.successorKind")}
            data={(["MILESTONE", "PROJECT"] as const).map((kind) => ({ value: kind, label: t(`project.dependency.kind.${kind}`) }))}
            value={form.values.successorKind}
            onChange={(value) => changeSuccessor({ successorKind: value as EndpointKind, successor: null })}
          />
          {form.values.successorKind === "MILESTONE" && projectId !== undefined && (
            <MilestoneSelect
              // A new project is a new search: the picker's own box and results start over.
              key={projectId}
              projectId={projectId}
              label={t("project.dependency.successor")}
              description={t("dependencyList.add.successorHint")}
              clearLabel={t("dependencyList.add.clearSuccessor")}
              dataAutofocus={startsOnProject}
              picked={form.values.successor}
              onPick={(picked) => changeSuccessor({ successor: picked })}
              error={form.errors.successor}
            />
          )}
          <PredecessorFields
            kind={form.values.predecessorKind}
            picked={form.values.predecessor}
            error={form.errors.predecessor}
            onKind={(kind) => {
              form.setFieldValue("predecessorKind", kind);
              pickPredecessor(null);
            }}
            onPick={pickPredecessor}
          />
          <TypeAndLagFields typeProps={form.getInputProps("type")} lagProps={form.getInputProps("lagDays")} />
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
