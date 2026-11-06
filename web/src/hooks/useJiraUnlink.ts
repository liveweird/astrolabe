import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { deleteJiraBinding } from "../api/jira";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { useDeleteConfirm } from "./useDeleteConfirm";

/** What an unlink names in its confirmation: the binding to delete, the Jira key and the plan item's name. */
export type UnlinkTarget = { bindingId: number; key: string; name: string };

/**
 * The request -> confirm -> `DELETE /integrations/jira/bindings/{id}` flow shared by the connection page's table and the project page (the owner's
 * unlink): `useDeleteConfirm` owns the dialog state, the toast and the focus (`focusAfterDelete`: the page's heading), and only the `["jira"]` queries
 * are refreshed - a binding is not plan state, so no timeline view is re-read.
 */
export function useJiraUnlink(focusAfterDelete: RefObject<HTMLElement | null>) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useDeleteConfirm<UnlinkTarget>({
    mutationFn: (target) => deleteJiraBinding(target.bindingId),
    onSuccess: () => refreshQueriesAfterMutation(queryClient, ["jira"]),
    successMessage: t("jira.toast.unlinked"),
    focusAfterDelete,
  });
}
