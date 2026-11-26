import { Alert, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { usePlanOrder } from "../hooks/usePlanOrder";
import FormErrorAlert from "./FormErrorAlert";

/**
 * What the Plan page says about re-arranging, above the table: why reordering is off (a dimmed note, named by the disabled Move items, shown only to a caller who
 * could otherwise re-arrange something), a change refused because a save was still running, the stale notice (the status region says it too, so these are
 * `role="note"`, never an alert that would read twice) and the inline failure of a write. A page that is not filtered shows none of it unless a write went wrong.
 */
export default function PlanOrderNotices({ order, off, noteId }: { order: ReturnType<typeof usePlanOrder>; off: boolean; noteId: string }) {
  const { t } = useTranslation();
  return (
    <>
      {off && (
        <Text id={noteId} role="note" size="xs" c="dimmed" data-print="hide">
          {t("plan.order.off")}
        </Text>
      )}
      {order.refused && (
        <Alert color="orange" variant="light" role="note">
          {t("project.busy")}
        </Alert>
      )}
      {order.stale && (
        <Alert color="orange" variant="light" role="note">
          {t("plan.order.stale")}
        </Alert>
      )}
      {order.error && <FormErrorAlert>{order.error}</FormErrorAlert>}
    </>
  );
}
