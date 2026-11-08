import { useTranslation } from "react-i18next";
import { Text } from "@mantine/core";
import ConfirmActionModal from "./ConfirmActionModal";

/**
 * The team page's Reset order dialog. `refused` (a write is running) is said inside it, since a modal's content is all a screen reader
 * reads; the dialog stays open until the reset was TAKEN.
 */
export default function TeamResetConfirm({ opened, refused, onClose, onConfirm }: { opened: boolean; refused: boolean; onClose: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  return (
    <ConfirmActionModal
      opened={opened}
      onClose={onClose}
      title={t("teams.view.resetTitle")}
      message={
        <>
          {t("teams.view.resetBody")}
          {refused && (
            <Text span display="block" mt="xs" role="alert">
              {t("project.busy")}
            </Text>
          )}
        </>
      }
      cancelLabel={t("common.action.cancel")}
      confirmLabel={t("teams.view.action.resetConfirm")}
      onConfirm={onConfirm}
      confirmColor="astrolabe"
    />
  );
}
