import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import type { RoadmapProject } from "../api/roadmap";
import { targetWindowFormValidation, type TargetWindowFormValues } from "../utils/planForm";
import PlanDateInput from "./PlanDateInput";

/**
 * "Edit target window…": the deterministic path to a project's target window on the roadmap and programs pages (the Roadmap rule - a drag
 * surface always ships explicit controls; the band's drag and the row draw are pointer-only, this dialog and the row menu are the keyboard and
 * touch path). Two inclusive dates with Save, and Clear for removing the window. Both hand the page the proposed window and the page's write
 * path (`useTargetWindow`) is optimistic: a taken change closes the dialog, a REFUSED one (a save is still running) keeps it open and says so
 * here (`refused`), and every other verdict - a 403, a 400 - shows on the page, not here.
 */
export default function TargetWindowModal({
  project,
  refused,
  onSave,
  onClear,
  onClose,
}: {
  /** Only the name and the current window matter. */
  project: Pick<RoadmapProject, "name" | "targetStart" | "targetEnd">;
  /** The last Save or Clear was refused because another write is still running (the dialog stays open and says so). */
  refused: boolean;
  onSave: (start: string, end: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const form = useForm<TargetWindowFormValues>({
    initialValues: { targetStart: project.targetStart, targetEnd: project.targetEnd },
    validate: targetWindowFormValidation(t),
  });
  const hasWindow = project.targetStart !== null;

  return (
    // The page puts the focus back on the row's menu button once the dialog is gone; the default return would aim at the menu item that opened it.
    <Modal closeButtonProps={{ "aria-label": t("common.action.close") }} opened onClose={onClose} returnFocus={false} title={t("roadmap.window.title", { name: project.name })} centered>
      <form
        onSubmit={form.onSubmit((values) => {
          if (values.targetStart !== null && values.targetEnd !== null) onSave(values.targetStart, values.targetEnd);
        })}
        noValidate
      >
        <Stack>
          <Text size="sm" c="dimmed">
            {t("roadmap.window.hint")}
          </Text>
          {refused && (
            <Alert color="orange" variant="light">
              {t("project.busy")}
            </Alert>
          )}
          <Group grow align="flex-start">
            <PlanDateInput label={t("plan.targetStart")} data-autofocus {...form.getInputProps("targetStart")} />
            <PlanDateInput label={t("plan.targetEnd")} {...form.getInputProps("targetEnd")} />
          </Group>
          <Group justify="space-between">
            <Button type="button" variant="default" onClick={onClear} disabled={!hasWindow}>
              {t("roadmap.window.clear")}
            </Button>
            <Group gap="sm">
              <Button type="button" variant="default" onClick={onClose}>
                {t("common.action.cancel")}
              </Button>
              <Button type="submit">{t("common.action.save")}</Button>
            </Group>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
