import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { Button, Select, Stack, Table } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconPlus, IconUsers } from "@tabler/icons-react";
import { HOME_VIEW_KEY } from "../api/home";
import { createPerson } from "../api/people";
import { deleteUser, listUsers, type UserResponse } from "../api/users";
import { getUserId } from "../api/session";
import { useAdmin } from "../auth";
import ClearableTextInput from "../components/ClearableTextInput";
import ConfirmActionModal from "../components/ConfirmActionModal";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal";
import EmptyState from "../components/EmptyState";
import FilterPanel from "../components/FilterPanel";
import OneTimePasswordModal from "../components/OneTimePasswordModal";
import PaginationBar from "../components/PaginationBar";
import SortHeader from "../components/SortHeader";
import TableLoadingRow from "../components/TableLoadingRow";
import UserTableRow from "../components/UserTableRow";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { FILTER_DEBOUNCE_MS, useClampPage, usePagedSort } from "../hooks/usePagedSort";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useResetPassword } from "../hooks/useResetPassword";
import { isString, useStoredState } from "../hooks/useStoredState";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";
import PageHeader from "../components/PageHeader";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { newUserPath } from "../utils/userLinks";
import ErrorAlert from "../components/ErrorAlert";
import FormErrorAlert from "../components/FormErrorAlert";

const SORT_FIELDS = ["name", "email"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const SETTINGS_KEY = "users";

export default function Users() {
  const { t } = useTranslation();
  const admin = useAdmin();
  const queryClient = useQueryClient();
  const currentUserId = getUserId();
  const [nameFilter, setNameFilter] = useStoredState(`${SETTINGS_KEY}.filter.name`, "", isString);
  const [emailFilter, setEmailFilter] = useStoredState(`${SETTINGS_KEY}.filter.email`, "", isString);
  const [roleFilter, setRoleFilter] = useStoredState(`${SETTINGS_KEY}.filter.role`, "", isString);
  const activeFilterCount =
    (nameFilter.trim() ? 1 : 0) + (emailFilter.trim() ? 1 : 0) + (roleFilter ? 1 : 0);

  const [debouncedName] = useDebouncedValue(nameFilter, FILTER_DEBOUNCE_MS);
  const [debouncedEmail] = useDebouncedValue(emailFilter, FILTER_DEBOUNCE_MS);

  const { page, setPage, pageSize, setPageSize, sortField, sortDir, sortParam, toggleSort } =
    usePagedSort<SortField>("name", [debouncedName, debouncedEmail, roleFilter], {
      key: SETTINGS_KEY,
      sortFields: SORT_FIELDS,
    });

  const { data, isLoading, isError, error, isPlaceholderData } = useQuery({
    queryKey: ["users", page, pageSize, sortParam, debouncedName, debouncedEmail, roleFilter],
    queryFn: () =>
      listUsers({
        page,
        pageSize,
        sort: sortParam,
        name: debouncedName || undefined,
        email: debouncedEmail || undefined,
        role: roleFilter || undefined,
      }),
    placeholderData: keepPreviousData,
    enabled: admin,
  });
  useClampPage(page, pageSize, setPage, data, isPlaceholderData);

  // "Create a person" is offered for a login whose row says no ACTIVE person links to it (`personId`, read with the list).
  // The failure is inline, tied to the view it happened in (a filter, sort or page change drops it) and cleared when
  // another row action starts.
  const viewKey = JSON.stringify([page, pageSize, sortParam, debouncedName, debouncedEmail, roleFilter]);
  const [personFailure, setPersonFailure] = useState<{ message: string; viewKey: string } | null>(null);
  const personError = personFailure?.viewKey === viewKey ? personFailure.message : null;
  const [creatingPersonFor, setCreatingPersonFor] = useState<number | null>(null);

  async function createPersonFor(user: UserResponse) {
    if (creatingPersonFor !== null) return;
    setPersonFailure(null);
    setCreatingPersonFor(user.id);
    try {
      await createPerson({ name: user.name, email: user.email, userId: user.id });
      await refreshQueriesAfterMutation(queryClient, ["people"], ["users"], HOME_VIEW_KEY);
      showSuccessToast(t("users.toast.personCreated"));
    } catch (err) {
      setPersonFailure({
        viewKey,
        message: saveErrorMessage(err, t, {
          conflict: "users.createPersonConflict",
          failedStatus: "users.createPersonFailedStatus",
          failed: "users.createPersonFailedNetwork",
        }),
      });
    } finally {
      setCreatingPersonFor(null);
    }
  }

  const titleRef = useRef<HTMLHeadingElement>(null);
  const deleteConfirm = useDeleteConfirm<UserResponse>({
    mutationFn: (row) => deleteUser(row.id),
    onSuccess: () => refreshQueriesAfterMutation(queryClient, ["users"]),
    successMessage: t("users.toast.deleted"),
    focusAfterDelete: titleRef,
  });

  // The reset flow: confirm → generate client-side → PUT → the one-time reveal modal.
  const reset = useResetPassword();
  // The confirm is followed by the one-time reveal: the focus returns to the kebab after the last of them closes.
  useDialogFocus(reset.target !== null || reset.revealed !== null);


  const total = data?.total ?? 0;
  const columnCount = 4;

  return (
    <Stack gap="md">
      <PageHeader
        titleRef={titleRef}
        title={t("users.title")}
        actions={
          <>
            <Button component={RouterLink} to={newUserPath} leftSection={<IconPlus size={16} />}>
              {t("users.createUser")}
            </Button>
          </>
        }
      />

      <FilterPanel activeFilterCount={activeFilterCount} storageKey={SETTINGS_KEY}>
        <ClearableTextInput
          label={t("common.field.name")}
          value={nameFilter}
          onChange={setNameFilter}
          clearLabel={t("common.filter.clearName")}
        />
        <ClearableTextInput
          label={t("common.field.email")}
          value={emailFilter}
          onChange={setEmailFilter}
          clearLabel={t("users.clearEmailFilter")}
        />
        <Select
          label={t("common.field.role")}
          placeholder={t("common.state.any")}
          data={[
            { value: "ADMIN", label: t("common.role.ADMIN") },
            { value: "USER", label: t("users.rolePlain") },
          ]}
          value={roleFilter || null}
          onChange={(v) => setRoleFilter(v ?? "")}
          clearable
          clearButtonProps={{ "aria-label": t("users.clearRoleFilter") }}
        />
      </FilterPanel>

      {isError && <ErrorAlert error={error} title={t("users.loadFailed")} />}
      {personError && <FormErrorAlert title={t("users.createPersonFailedTitle")}>{personError}</FormErrorAlert>}

      <Table aria-label={t("users.title")}>
        <Table.Thead>
          <Table.Tr>
            <SortHeader
              field="name"
              label={t("common.field.name")}
              activeField={sortField}
              activeDir={sortDir}
              onToggle={toggleSort}
            />
            <SortHeader
              field="email"
              label={t("common.field.email")}
              activeField={sortField}
              activeDir={sortDir}
              onToggle={toggleSort}
            />
            <Table.Th>{t("common.field.role")}</Table.Th>
            <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {isLoading && !data ? (
            <TableLoadingRow colSpan={columnCount} />
          ) : data && data.items.length > 0 ? (
            data.items.map((user) => (
              <UserTableRow
                key={user.id}
                user={user}
                self={user.id === currentUserId}
                onCreatePerson={() => void createPersonFor(user)}
                onResetPassword={() => {
                  setPersonFailure(null);
                  reset.request(user);
                }}
                onDelete={() => {
                  setPersonFailure(null);
                  deleteConfirm.requestDelete(user);
                }}
              />
            ))
          ) : !isError ? (
            <Table.Tr>
              <Table.Td colSpan={columnCount}>
                <EmptyState
                  icon={IconUsers}
                  label={t("users.noUsers")}
                />
              </Table.Td>
            </Table.Tr>
          ) : null}
        </Table.Tbody>
      </Table>

      <PaginationBar
        total={total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      <ConfirmDeleteModal
        confirm={deleteConfirm}
        title={t("users.deleteTitle")}
        errorTitle={t("users.deleteFailed")}
        errorMessage={(err) =>
          saveErrorMessage(err, t, {
            conflict: "users.lastAdminError",
            failedStatus: "common.error.actionFailedStatus",
            failed: "common.error.actionFailed",
          })
        }
        body={(target) => (
          <>
            {t("users.deleteBody", { name: target.name, email: target.email })}{" "}
            {t("users.deleteUndone")}
          </>
        )}
      />

      <ConfirmActionModal
        opened={reset.target !== null}
        onClose={reset.clearTarget}
        title={t("users.resetTitle")}
        message={reset.target ? t("users.resetBody", { name: reset.target.name }) : null}
        error={
          reset.error && (
            <FormErrorAlert title={t("users.resetFailedTitle")}>{reset.error}</FormErrorAlert>
          )
        }
        cancelLabel={t("common.action.cancel")}
        confirmLabel={t("users.resetConfirm")}
        confirmColor="astrolabe"
        onConfirm={() => void reset.confirm()}
        loading={reset.pending}
      />

      <OneTimePasswordModal
        reveal={reset.revealed}
        title={t("users.resetDoneTitle")}
        onClose={reset.closeReveal}
      />
    </Stack>
  );
}
