import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { Badge, Button, Group, Menu, Select, Stack, Table, Text } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconKey,
  IconPencil,
  IconPlus,
  IconShieldCheck,
  IconToggleLeft,
  IconTrash,
  IconUserPlus,
  IconUsers,
} from "@tabler/icons-react";
import { createPerson } from "../api/people";
import { deleteUser, listUsers, type UserResponse } from "../api/users";
import { getUserId } from "../api/session";
import { useAdmin } from "../auth";
import ClearableTextInput from "../components/ClearableTextInput";
import ConfirmActionModal from "../components/ConfirmActionModal";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal";
import DestructiveMenuItem from "../components/DestructiveMenuItem";
import EmptyState from "../components/EmptyState";
import FilterPanel from "../components/FilterPanel";
import OneTimePasswordModal from "../components/OneTimePasswordModal";
import PaginationBar from "../components/PaginationBar";
import RowActionsMenu from "../components/RowActionsMenu";
import SortHeader from "../components/SortHeader";
import TableLoadingRow from "../components/TableLoadingRow";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { usePagedSort } from "../hooks/usePagedSort";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useResetPassword } from "../hooks/useResetPassword";
import { isString, useStoredState } from "../hooks/useStoredState";
import { saveErrorMessage } from "../utils/saveError";
import { showSuccessToast } from "../utils/toast";
import PageHeader from "../components/PageHeader";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { editUserPath, newUserPath, userFeaturesPath, userPermissionsPath } from "../utils/userLinks";
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

  const [debouncedName] = useDebouncedValue(nameFilter, 300);
  const [debouncedEmail] = useDebouncedValue(emailFilter, 300);

  const { page, setPage, pageSize, setPageSize, sortField, sortDir, sortParam, toggleSort } =
    usePagedSort<SortField>("name", [debouncedName, debouncedEmail, roleFilter], {
      key: SETTINGS_KEY,
      sortFields: SORT_FIELDS,
    });

  const { data, isLoading, isError, error } = useQuery({
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
      await refreshQueriesAfterMutation(queryClient, ["people"], ["users"]);
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
            data.items.map((user) => {
              const self = user.id === currentUserId;
              return (
                <Table.Tr key={user.id}>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" fw={500}>
                        {user.name}
                      </Text>
                      {self && (
                        <Badge size="xs" variant="light">
                          {t("users.youBadge")}
                        </Badge>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{user.email}</Text>
                  </Table.Td>
                  <Table.Td>
                    {user.roles.includes("ADMIN") ? (
                      <Badge variant="outline" color="gray" size="sm">
                        {t("common.role.ADMIN")}
                      </Badge>
                    ) : (
                      <Text size="sm" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td style={{ width: 1 }} ta="right">
                    <RowActionsMenu label={t("common.table.operationsAria", { name: user.name })}>
                      <Menu.Item
                        component={RouterLink}
                        to={editUserPath(user.id)}
                        leftSection={<IconPencil size={14} />}
                        aria-label={t("common.action.editAria", { name: user.name })}
                      >
                        {t("common.action.edit")}
                      </Menu.Item>
                      <Menu.Item
                        component={RouterLink}
                        to={userFeaturesPath(user.id)}
                        leftSection={<IconToggleLeft size={14} />}
                        aria-label={t("users.featuresAria", { name: user.name })}
                      >
                        {t("users.featuresAction")}
                      </Menu.Item>
                      <Menu.Item
                        component={RouterLink}
                        to={userPermissionsPath(user.id)}
                        leftSection={<IconShieldCheck size={14} />}
                        aria-label={t("users.permissionsAria", { name: user.name })}
                      >
                        {t("users.permissionsAction")}
                      </Menu.Item>
                      {user.personId == null && (
                        <Menu.Item
                          leftSection={<IconUserPlus size={14} />}
                          onClick={() => void createPersonFor(user)}
                          aria-label={t("users.createPersonAria", { name: user.name })}
                        >
                          {t("users.createPerson")}
                        </Menu.Item>
                      )}
                      {/* Own row: no reset (self-change needs the current password — the
                          Change password page) and no delete (the server 403s it anyway). */}
                      {!self && (
                        <>
                          <Menu.Divider />
                          <Menu.Item
                            leftSection={<IconKey size={14} />}
                            onClick={() => {
                              setPersonFailure(null);
                              reset.request(user);
                            }}
                            aria-label={t("users.resetPasswordAria", { name: user.name })}
                          >
                            {t("users.resetPassword")}
                          </Menu.Item>
                          <DestructiveMenuItem
                            leftSection={<IconTrash size={14} />}
                            onClick={() => {
                              setPersonFailure(null);
                              deleteConfirm.requestDelete(user);
                            }}
                            aria-label={t("common.action.deleteAria", { name: user.name })}
                          >
                            {t("common.action.delete")}
                          </DestructiveMenuItem>
                        </>
                      )}
                    </RowActionsMenu>
                  </Table.Td>
                </Table.Tr>
              );
            })
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
