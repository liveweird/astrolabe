import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { deleteJiraBinding } from "../api/jira";
import { refreshJiraAndTimelines } from "../utils/queryRefresh";
import { useDeleteConfirm } from "./useDeleteConfirm";

/** What an unlink names in its confirmation: the binding to delete, the Jira key and the plan item's name. */
export type UnlinkTarget = { bindingId: number; key: string; name: string };

/**
 * The request -> confirm -> `DELETE /integrations/jira/bindings/{id}` flow shared by the connection page's table and the project page (the owner's
 * unlink): `useDeleteConfirm` owns the dialog state, the toast and the focus (`focusAfterDelete`: the page's heading), and the success refreshes the
 * Jira queries AND the timeline views (`refreshJiraAndTimelines`): the link's flags and bar leave them.
 */
export function useJiraUnlink(focusAfterDelete: RefObject<HTMLElement | null>) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useDeleteConfirm<UnlinkTarget>({
    mutationFn: (target) => deleteJiraBinding(target.bindingId),
    onSuccess: () => refreshJiraAndTimelines(queryClient),
    successMessage: t("jira.toast.unlinked"),
    focusAfterDelete,
  });
}
