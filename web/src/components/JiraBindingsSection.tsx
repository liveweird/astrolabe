import { useRef, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Anchor, Badge, Button, Group, Select, Stack, Table, Text, Title } from "@mantine/core";
import { IconFileImport, IconLink, IconLinkOff } from "@tabler/icons-react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeviationConnection } from "../api/deviations";
import { listJiraBindings, type JiraBinding, type JiraConnection, type JiraLevel } from "../api/jira";
import { useJiraUnlink } from "../hooks/useJiraUnlink";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { useRegistryListControls } from "../hooks/useRegistryListControls";
import { formatDateTime } from "../utils/formatDate";
import { projectPath } from "../utils/planLinks";
import { refreshJiraAndTimelines } from "../utils/queryRefresh";
import ClearableTextInput from "./ClearableTextInput";
import JiraBindDialog from "./JiraBindDialog";
import JiraImportModal from "./JiraImportModal";
import JiraKeyLink from "./JiraKeyLink";
import JiraUnlinkModal from "./JiraUnlinkModal";
import RegistryListTable from "./RegistryListTable";
import SortHeader from "./SortHeader";

const SORT_FIELDS = ["issueKey", "createdAt"] as const;
type SortField = (typeof SORT_FIELDS)[number];
const LEVELS: readonly JiraLevel[] = ["PROGRAM", "PROJECT", "MILESTONE"];

/**
 * This page's connection as the dialog's one choice. The registry row does not say whether the mapping fits the site now (`mappingOk` is the
 * deviations view's verdict), so it is taken as fitting: a stale mapping is then the SERVER's refusal, shown inline (409 `jira-mapping-invalid`).
 */
const fixedConnection = ({ id, name, siteUrl, enabled, projectKeys, status }: JiraConnection): DeviationConnection => ({
  id,
  name,
  siteUrl,
  enabled,
  projectKeys,
  mappingOk: true,
  lastRun: status.lastRun,
  status,
});

const levelWord = (kind: JiraLevel) => `jira.mapping.level.${kind.toLowerCase() as "program" | "project" | "milestone"}` as const;

/** The node's name (a project's is the link into its page) with where it sits, dimmed. A milestone's binding carries the project's NAME only, so it is not a link. */
function NodeCell({ binding }: { binding: JiraBinding }) {
  const { node } = binding;
  const context = [node.projectName, node.programName, node.workStreamName].filter((part): part is string => Boolean(part)).join(" · ");
  return (
    <>
      {node.kind === "PROJECT" ? (
        <Anchor component={RouterLink} to={projectPath(node.id)} size="sm" fw={500}>
          {node.name}
        </Anchor>
      ) : (
        <Text size="sm" fw={500}>
          {node.name}
        </Text>
      )}
      {context !== "" && (
        <Text size="xs" c="dimmed">
          {context}
        </Text>
      )}
    </>
  );
}

/**
 * The connection page's third section: the paged list of the plan items linked through this connection (any signed-in user may read it; this
 * page is ADMIN's), a level filter and a name filter (`q`), Unlink behind a confirmation and "Link a node…" (the bind dialog, locked to this
 * connection). The list hides bindings of deleted plan items (the server's rule), so a delete's count and this table may differ by those.
 */
export default function JiraBindingsSection({ connection }: { connection: JiraConnection }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [level, setLevel] = useState<JiraLevel | null>(null);
  const controls = useRegistryListControls<SortField>({ settingsKey: "jiraBindings", sortFields: SORT_FIELDS, initialSortField: "issueKey", extraFilterDeps: [level] });
  const { page, setPage, pageSize, setPageSize, sortField, sortDir, sortParam, toggleSort } = controls;
  const q = controls.debouncedName.trim();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["jira", "bindings", connection.id, page, pageSize, sortParam, level, q],
    queryFn: () => listJiraBindings({ page, pageSize, connectionId: connection.id, level: level ?? undefined, q: q === "" ? undefined : q, sort: sortParam }),
    placeholderData: keepPreviousData,
  });

  const [binding, setBinding] = useState(false);
  const [importing, setImporting] = useState(false);
  useDialogFocus(binding || importing);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const unlink = useJiraUnlink(titleRef);
  const filtered = level !== null || q !== "";
  const canImport = connection.enabled && connection.discoveredAt != null;

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center" wrap="wrap">
        <Title order={3} size="h4" ref={titleRef} tabIndex={-1}>
          {t("jira.bindings.title")}
        </Title>
        <Group gap="sm">
          {/* The import needs a stored discovery (a passing Test connection) to read the mapping against; the server's 409 covers a mapping that no longer fits. */}
          <Button
            variant="default"
            leftSection={<IconFileImport size={16} />}
            disabled={!canImport}
            onClick={() => setImporting(true)}
          >
            {t("jira.import.entry")}
          </Button>
          <Button variant="default" leftSection={<IconLink size={16} />} disabled={!connection.enabled} onClick={() => setBinding(true)}>
            {t("jira.bindings.linkNode")}
          </Button>
        </Group>
      </Group>
      <Text size="sm" c="dimmed">
        {t("jira.bindings.intro")}
      </Text>
      {!canImport && (
        <Text size="xs" c="dimmed" role="note">
          {t("jira.bindings.importDisabled")}
        </Text>
      )}
      <Group align="flex-end" gap="sm" wrap="wrap">
        <Select
          label={t("jira.bindings.filter.level")}
          placeholder={t("common.state.any")}
          data={LEVELS.map((value) => ({ value, label: t(levelWord(value)) }))}
          value={level}
          onChange={(value) => setLevel(value as JiraLevel | null)}
          clearable
          clearButtonProps={{ "aria-label": t("jira.bindings.filter.clearLevel") }}
          w={220}
        />
        <ClearableTextInput label={t("jira.bindings.filter.name")} value={controls.nameFilter} onChange={controls.setNameFilter} clearLabel={t("jira.bindings.filter.clearName")} />
      </Group>
      <RegistryListTable
        label={t("jira.bindings.tableAria")}
        errorTitle={t("jira.bindings.loadFailed")}
        error={error}
        isError={isError}
        isLoading={isLoading}
        hasData={Boolean(data)}
        rowCount={data?.items.length ?? 0}
        columnCount={6}
        scrollMinWidth={860}
        emptyIcon={IconLinkOff}
        emptyLabel={filtered ? t("jira.bindings.noMatch") : t("jira.bindings.empty")}
        header={
          <Table.Tr>
            <Table.Th>{t("jira.bindings.column.node")}</Table.Th>
            <Table.Th>{t("jira.bindings.column.level")}</Table.Th>
            <SortHeader field="issueKey" label={t("jira.bindings.column.issue")} activeField={sortField} activeDir={sortDir} onToggle={toggleSort} />
            <SortHeader field="createdAt" label={t("jira.bindings.column.linked")} activeField={sortField} activeDir={sortDir} onToggle={toggleSort} />
            <Table.Th>{t("jira.bindings.column.by")}</Table.Th>
            <Table.Th aria-label={t("common.table.operations")} style={{ width: 1 }} />
          </Table.Tr>
        }
        rows={data?.items.map((row) => (
          <Table.Tr key={row.id}>
            <Table.Td>
              <NodeCell binding={row} />
            </Table.Td>
            <Table.Td>
              <Text size="sm">{t(levelWord(row.level))}</Text>
            </Table.Td>
            <Table.Td>
              <Group gap="xs" wrap="nowrap">
                <Text size="sm" fw={500}>
                  <JiraKeyLink issueKey={row.issueKey} siteUrl={connection.siteUrl} />
                </Text>
                {row.observation?.gone && (
                  <Badge color="orange" variant="light" tt="none">
                    {t("jira.bindings.gone")}
                  </Badge>
                )}
              </Group>
              {row.observation?.summary && (
                <Text size="xs" c="dimmed" lineClamp={1} maw={280} title={row.observation.summary}>
                  {row.observation.summary}
                </Text>
              )}
            </Table.Td>
            <Table.Td>
              <Text size="sm">{formatDateTime(row.createdAt)}</Text>
            </Table.Td>
            <Table.Td>
              <Text size="sm">{row.createdBy?.name ?? "—"}</Text>
            </Table.Td>
            <Table.Td style={{ width: 1 }} ta="right">
              <Button variant="subtle" size="compact-sm" color="gray" onClick={() => unlink.requestDelete({ bindingId: row.id, key: row.issueKey, name: row.node.name })} aria-label={t("jira.bindings.unlinkAria", { name: row.node.name })}>
                {t("jira.bindings.unlink")}
              </Button>
            </Table.Td>
          </Table.Tr>
        ))}
        total={data?.total ?? 0}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
      <Text size="xs" c="dimmed">
        {t("jira.bindings.deadNote")}
      </Text>

      {binding && (
        <JiraBindDialog
          source={{ connections: [fixedConnection(connection)], failed: false, retry: () => undefined }}
          connectionId={connection.id}
          onClose={() => setBinding(false)}
          onBound={async () => {
            setBinding(false);
            await refreshJiraAndTimelines(queryClient);
          }}
        />
      )}
      {importing && <JiraImportModal source={{ connections: [connection], failed: false, retry: () => undefined }} onClose={() => setImporting(false)} />}
      <JiraUnlinkModal confirm={unlink} />
    </Stack>
  );
}
