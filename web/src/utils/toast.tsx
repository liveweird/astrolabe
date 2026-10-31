import { notifications } from "@mantine/notifications";
import { IconCheck } from "@tabler/icons-react";

/**
 * The one success-toast entry point (host: `<Notifications />` in main.tsx). Success only —
 * errors stay inline (red Alerts next to the form/list). Green is the semantic-success color
 * (never teal: its tints are near-identical to the cyan brand's).
 *
 * Content rule: pass fixed vocabulary (`t("<area>.toast.*")`) only — NEVER user-entered
 * names/values.
 */
export function showSuccessToast(message: string) {
  notifications.show({ message, color: "green", icon: <IconCheck size={16} /> });
}
