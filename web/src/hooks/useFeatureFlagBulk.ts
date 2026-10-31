import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { updateUserFeatures, type UserPage } from "../api/users";
import type { Feature } from "../api/session";
import { isFeatureEnabled, withFeatureEnabled, type UserRow } from "../utils/featureFlags";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";
import { useBulkFeatureUpdate } from "./useBulkFeatureUpdate";

/** Rows per page when the bulk run pages through every row matching the current filters. */
const BULK_PAGE_SIZE = 100;

/**
 * The /feature-flags bulk enable/disable: `useBulkFeatureUpdate` wired to this screen. The fetch
 * pages through EVERY row matching the CURRENT filters (`fetchPage`), the affected rows are the
 * ones not already in the target state, and each is rewritten with the same per-user wholesale
 * PUT as a single switch. `noChange` is the neutral "nothing to change" note, scoped to the
 * filter it was computed for (`filterKey`), so any filter change hides it. A failed prepare
 * reports through `onError`; a partial failure renders from `bulk.failed`, never a toast.
 */
export function useFeatureFlagBulk({
  feature,
  filterKey,
  fetchPage,
  onError,
}: {
  feature: Feature;
  filterKey: string;
  fetchPage: (page: number, pageSize: number) => Promise<UserPage>;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [noChangeFor, setNoChangeFor] = useState<string | null>(null);

  const bulk = useBulkFeatureUpdate<UserRow>({
    fetchAll: async () => {
      const rows: UserRow[] = [];
      for (let page = 1; ; page += 1) {
        const result = await fetchPage(page, BULK_PAGE_SIZE);
        rows.push(...result.items);
        if (rows.length >= result.total || result.items.length === 0) return rows;
      }
    },
    isAffected: (row, targetEnabled) =>
      isFeatureEnabled(row.disabledFeatures, feature) !== targetEnabled,
    applyOne: (row, targetEnabled) =>
      updateUserFeatures(row.id, withFeatureEnabled(row.disabledFeatures, feature, targetEnabled)),
    onNothingToDo: () => setNoChangeFor(filterKey),
    onDone: async (failedRows) => {
      await refreshQueriesAfterMutation(queryClient, ["users"]);
      if (failedRows.length === 0) showSuccessToast(t("users.toast.featuresSaved"));
    },
    onPrepareError: (err) =>
      onError(
        saveErrorMessage(err, t, {
          failedStatus: "users.featuresFailedStatus",
          failed: "users.featuresFailedNetwork",
        }),
      ),
  });

  return {
    bulk,
    noChange: noChangeFor === filterKey,
    resetNotice: () => setNoChangeFor(null),
  };
}

export type FeatureFlagBulk = ReturnType<typeof useFeatureFlagBulk>;
