import { notifications } from "@mantine/notifications";
import { IconCheck } from "@tabler/icons-react";
import i18n from "../i18n";

/**
 * The one success-toast entry point (host: `<Notifications />` in main.tsx). Success only —
 * errors stay inline (red Alerts next to the form/list). Green is the semantic-success color
 * (never teal: its tints are near-identical to the cyan brand's).
 *
 * Content rule: pass fixed vocabulary (`t("<area>.toast.*")`) only — NEVER user-entered
 * names/values.
 *
 * Mantine's Notification close X has no default accessible name (axe `button-name`), and the
 * host sits outside any component that could call `useTranslation`, so the name is resolved
 * here, at show time, in the active language — every toast the app shows passes through this
 * function.
 */
export function showSuccessToast(message: string) {
  notifications.show({
    message,
    color: "green",
    icon: <IconCheck size={16} />,
    closeButtonProps: { "aria-label": i18n.t("common.action.closeNotification") },
  });
}
