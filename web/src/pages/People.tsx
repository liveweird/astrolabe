import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Anchor, Button, Menu, Stack, Table, Text } from "@mantine/core";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconAddressBook, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useAdmin } from "../auth";
import { deletePerson, listPeople, type PersonListItem, type PersonResponse } from "../api/people";
import ClearableTextInput from "../components/ClearableTextInput";
import ConfirmDeleteModal from "../components/ConfirmDeleteModal";
import FilterPanel from "../components/FilterPanel";
import PageHeader from "../components/PageHeader";
import PersonEditorModal from "../components/PersonEditorModal";
import RegistryListTable from "../components/RegistryListTable";
import RowActionsMenu from "../components/RowActionsMenu";
import SortHeader from "../components/SortHeader";
import { useDeleteConfirm } from "../hooks/useDeleteConfirm";
import { useRegistryListControls } from "../hooks/useRegistryListControls";
import { personPath } from "../utils/peopleLinks";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { saveErrorMessage } from "../utils/saveError";

const SORT_FIELDS = ["name", "email", "updatedAt"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const SETTINGS_KEY = "people";

/**
 * The People registry (`/people`): everyone gets the paged list, emails included (the owners and managers of the plan);
 * an ADMIN additionally creates, edits and deletes people (a modal per person — the registry shape).
 */
export default function People() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const admin = useAdmin();
  const { nameFilter, setNameFilter, debouncedName, nameFilterActive, page, setPage, pageSize, setPageSize, sortField, sortDir, sortParam, toggleSort } =
    useRegistryListControls<SortField>({ settingsKey: SETTINGS_KEY, sortFields: SORT_FIELDS, initialSortField: "name" });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["people", "list", page, pageSize, sortParam, debouncedName],
    queryFn: () => listPeople({ page, pageSize, sort: sortParam, name: debouncedName || undefined }),
    placeholderData: keepPreviousData,
  });

  // A list row carries every field of the detail, so it is the editor's target as it stands.
  const [editorTarget, setEditorTarget] = useState<PersonResponse | "new" | null>(null);

  const titleRef = useRef<HTMLHeadingElement>(null);
  const remove = useDeleteConfirm<PersonListItem>({
    mutationFn: (row) => deletePerson(row.id),
    onSuccess: () => refreshQueriesAfterMutation(queryClient, ["people"]),
    successMessage: t("people.toast.deleted"),
    focusAfterDelete: titleRef,
  });

  const total = data?.total ?? 0;
  const columnCount = 4;

  return (
    <Stack gap="md">
      <PageHeader
        titleRef={titleRef}
        title={t("people.title")}
        description={t("people.intro")}
        actions={
          admin && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => setEditorTarget("new")}>
              {t("people.newPerson")}
            </Button>
          )
        }
      />

      <FilterPanel activeFilterCount={nameFilterActive ? 1 : 0} storageKey={SETTINGS_KEY}>
        <ClearableTextInput
          label={t("common.field.name")}
          value={nameFilter}
          onChange={setNameFilter}
          clearLabel={t("common.filter.clearName")}
        />
      </FilterPanel>

      <RegistryListTable
        label={t("people.title")}
        errorTitle={t("people.loadFailed")}
        error={error}
        isError={isError}
        isLoading={isLoading}
        hasData={Boolean(data)}
        rowCount={data?.items.length ?? 0}
        columnCount={columnCount}
        emptyIcon={IconAddressBook}
        emptyLabel={t("people.empty")}
        header={
          <Table.Tr>
            <SortHeader field="name" label={t("common.field.name")} activeField={sortField} activeDir={sortDir} onToggle={toggleSort} />
            <SortHeader field="email" label={t("common.field.email")} activeField={sortField} activeDir={sortDir} onToggle={toggleSort} />
            <Table.Th>{t("people.column.login")}</Table.Th>
            <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />
          </Table.Tr>
        }
        rows={data?.items.map((person) => (
          <Table.Tr key={person.id}>
            <Table.Td>
              {/* The name is the way into the person page — a real link (the detail-link rule). */}
              <Anchor component={RouterLink} to={personPath(person.id)} fw={500} size="sm" aria-label={t("people.openAria", { name: person.name })}>
                {person.name}
              </Anchor>
            </Table.Td>
            <Table.Td>
              <Text size="sm" c={person.email ? undefined : "dimmed"}>
                {person.email ?? "—"}
              </Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm" c={person.userEmail ? undefined : "dimmed"}>
                {person.userEmail ?? "—"}
              </Text>
            </Table.Td>
            <Table.Td style={{ width: 1 }} ta="right">
              {admin && (
                <RowActionsMenu label={t("common.table.operationsAria", { name: person.name })}>
                  <Menu.Item
                    leftSection={<IconPencil size={14} />}
                    onClick={() => setEditorTarget(person)}
                    aria-label={t("common.action.editAria", { name: person.name })}
                  >
                    {t("common.action.edit")}
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item
                    color="red"
                    leftSection={<IconTrash size={14} />}
                    onClick={() => remove.requestDelete(person)}
                    aria-label={t("common.action.deleteAria", { name: person.name })}
                  >
                    {t("common.action.delete")}
                  </Menu.Item>
                </RowActionsMenu>
              )}
            </Table.Td>
          </Table.Tr>
        ))}
        total={total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      {editorTarget !== null && (
        <PersonEditorModal
          target={editorTarget === "new" ? null : editorTarget}
          onClose={() => setEditorTarget(null)}
          onSaved={async (saved) => {
            setEditorTarget(null);
            await refreshQueriesAfterMutation(queryClient, ["people"]);
            // A NEW person lands on their page.
            if (saved) navigate(personPath(saved.id));
          }}
        />
      )}

      <ConfirmDeleteModal
        confirm={remove}
        title={t("people.deleteTitle")}
        errorTitle={t("people.deleteFailed")}
        errorMessage={(err) =>
          saveErrorMessage(err, t, {
            conflict: "people.deleteConflict",
            failedStatus: "common.error.actionFailedStatus",
            failed: "common.error.actionFailed",
          })
        }
        body={(person) => t("people.deleteBody", { name: person.name })}
      />
    </Stack>
  );
}
