import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useTranslation } from "react-i18next";
import type { ProjectMilestone } from "../api/milestones";
import { useHolidays } from "../hooks/useHolidays";
import { scheduleFormValidation, type ScheduleFormValues } from "../utils/milestoneForm";
import PlanDateInput from "./PlanDateInput";

/**
 * "Edit schedule…": the deterministic path to a milestone's dates (the Roadmap rule — a drag surface always ships explicit
 * controls). Two inclusive dates, Save and Unschedule; both hand the page the proposed dates and close at once — the page's write
 * path (`useMilestoneSchedule`) is optimistic, and its verdict (stale notice, refusal) shows on the page, not here.
 */
export default function MilestoneScheduleModal({
  milestone,
  refused,
  onSchedule,
  onUnschedule,
  onClose,
}: {
  /** Any page's milestone (the project view's and the team view's): only its name and dates matter here. */
  milestone: Pick<ProjectMilestone, "name" | "startDate" | "endDate">;
  /** The last Save/Unschedule was refused because another save is still running (the dialog stays open, and says so here). */
  refused: boolean;
  onSchedule: (start: string, end: string) => void;
  onUnschedule: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // The pre-check counts the cached dictionary's holidays (the server's check on the PUT is the rule; a dictionary still loading checks Mon-Fri only).
  const holidayDays = new Set(useHolidays().holidays.map((holiday) => holiday.date));
  const form = useForm<ScheduleFormValues>({
    initialValues: { startDate: milestone.startDate, endDate: milestone.endDate },
    validate: scheduleFormValidation(t, holidayDays),
  });
  const scheduled = milestone.startDate !== null;

  return (
    <Modal
      closeButtonProps={{ "aria-label": t("common.action.close") }}
      opened
      onClose={onClose}
      title={t("project.milestone.scheduleTitle", { name: milestone.name })}
      centered
    >
      <form
        onSubmit={form.onSubmit((values) => {
          if (values.startDate !== null && values.endDate !== null) onSchedule(values.startDate, values.endDate);
        })}
        noValidate
      >
        <Stack>
          <Text size="sm" c="dimmed">
            {t("project.milestone.scheduleHint")}
          </Text>
          {refused && (
            <Alert color="orange" variant="light">
              {t("project.busy")}
            </Alert>
          )}
          <Group grow align="flex-start">
            <PlanDateInput label={t("common.field.startDate")} data-autofocus {...form.getInputProps("startDate")} />
            <PlanDateInput label={t("common.field.endDate")} {...form.getInputProps("endDate")} />
          </Group>
          <Group justify="space-between">
            <Button type="button" variant="default" onClick={onUnschedule} disabled={!scheduled}>
              {t("project.action.unschedule")}
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
