import { useTranslation } from "react-i18next";
import type { DeleteConfirm } from "../hooks/useDeleteConfirm";
import type { UnlinkTarget } from "../hooks/useJiraUnlink";
import { saveErrorMessage } from "../utils/saveError";
import ConfirmDeleteModal from "./ConfirmDeleteModal";

/** The unlink confirmation (`useJiraUnlink`): names the plan item and the key, says nothing changes in Jira, and keeps a refusal (403, 404) inline. */
export default function JiraUnlinkModal({ confirm }: { confirm: DeleteConfirm<UnlinkTarget> }) {
  const { t } = useTranslation();
  return (
    <ConfirmDeleteModal
      confirm={confirm}
      title={t("jira.bindings.unlinkTitle")}
      errorTitle={t("jira.bindings.unlinkFailed")}
      confirmLabel={t("jira.bindings.unlink")}
      errorMessage={(err) =>
        saveErrorMessage(err, t, {
          forbidden: "jira.bindings.unlinkForbidden",
          notFound: "jira.bindings.unlinkGone",
          failedStatus: "common.error.actionFailedStatus",
          failed: "common.error.actionFailed",
        })
      }
      body={(target) => t("jira.bindings.unlinkBody", { name: target.name, key: target.key })}
    />
  );
}
