import { useTranslation } from "react-i18next";
import type { DeleteConfirm } from "../hooks/useDeleteConfirm";
import { dependencyEndpointText, type EditableDependency } from "../utils/dependencyForm";
import { saveErrorMessage } from "../utils/saveError";
import ConfirmDeleteModal from "./ConfirmDeleteModal";

/**
 * The confirmation to delete a dependency, shared by the project page and the Dependencies page (1.22): the wording and the error mapping live
 * here once. `ownProjectId` is the page's own project (its milestones are named without a project); `null` = the list page, where every
 * milestone end names its project.
 */
export default function DependencyDeleteModal<T extends EditableDependency>({ confirm, ownProjectId }: { confirm: DeleteConfirm<T>; ownProjectId: number | null }) {
  const { t } = useTranslation();
  return (
    <ConfirmDeleteModal
      confirm={confirm}
      title={t("project.dependency.deleteTitle")}
      errorTitle={t("project.dependency.deleteFailed")}
      errorMessage={(error) =>
        saveErrorMessage(error, t, {
          forbidden: "project.dependency.saveForbidden",
          notFound: "project.saveGone",
          failedStatus: "common.error.actionFailedStatus",
          failed: "common.error.actionFailed",
        })
      }
      body={(dependency) =>
        t("project.dependency.deleteBody", {
          predecessor: dependencyEndpointText(dependency.predecessor, ownProjectId, t),
          successor: dependencyEndpointText(dependency.successor, ownProjectId, t),
          type: dependency.type,
        })
      }
    />
  );
}
