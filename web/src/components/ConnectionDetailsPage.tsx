import { useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Box, Button, Stack } from "@mantine/core";
import { IconPencil } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/http";
import { useAdmin } from "../auth";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { CONTENT_MAX_WIDTH } from "../utils/layout";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { loadErrorMessage } from "../utils/saveError";
import { IDLE_REFRESH_MS } from "../utils/syncRuns";
import EditPageLoadState from "./EditPageLoadState";
import PageHeader from "./PageHeader";

/** What differs between the connector pages: the registry's name (query-key root and `<kind>.*` i18n namespace), its list route, the read, the sections, the editor. */
export type ConnectionDetailsProps<C extends { name: string }> = {
  kind: "jira" | "flow";
  /** The connector's list route (the back link and the load-failure button). */
  connectionsPath: string;
  fetchConnection: (id: number) => Promise<C>;
  /** The page's h3 sections, in order; `readAt` is the connection query's `dataUpdatedAt` (the staleness reference of the facts). */
  sections: (connection: C, readAt: number) => ReactNode;
  /** The edit modal, mounted while editing. */
  Editor: ComponentType<{ target: C; onClose: () => void; onSaved: () => Promise<void> }>;
};

/**
 * The shell behind the Jira and Flow connection pages (`/integrations/<kind>/:id`, ADMIN only): the route-param parse, the load triage (loader, not
 * found, load failure), the header with its Edit button, the sections column and the editor modal. The connector keeps its sections and editor.
 */
export default function ConnectionDetailsPage<C extends { name: string }>(props: ConnectionDetailsProps<C>) {
  const { id: idParam } = useParams();
  // Keyed by the route's id: an in-place change of `:id` starts the page over (test result, editor, notes), never carries them across.
  return <ConnectionPage key={idParam} idParam={idParam} {...props} />;
}

function ConnectionPage<C extends { name: string }>({
  idParam,
  kind,
  connectionsPath,
  fetchConnection,
  sections,
  Editor,
}: ConnectionDetailsProps<C> & { idParam: string | undefined }) {
  const { t } = useTranslation();
  const id = Number(idParam);
  const idIsValid = Number.isInteger(id) && id > 0;
  const admin = useAdmin();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  useDialogFocus(editing);

  // Re-read slowly while the page is visible: the scheduler starts runs (and moves the status) without anyone clicking.
  const connection = useQuery({ queryKey: [kind, "connection", id], queryFn: () => fetchConnection(id), enabled: idIsValid && admin, refetchInterval: IDLE_REFRESH_MS });

  if (!idIsValid || connection.isLoading || connection.isError || !connection.data) {
    const notFound = !idIsValid || (connection.error instanceof ApiError && connection.error.status === 404);
    return (
      <EditPageLoadState
        isLoading={idIsValid && connection.isLoading}
        message={notFound ? t(`${kind}.notFound`) : loadErrorMessage(connection.error, t)}
        backTo={connectionsPath}
        backLabel={t(`${kind}.backToConnections`)}
        title={t(`${kind}.title`)}
      />
    );
  }
  const data = connection.data;

  return (
    <Stack gap="md">
      <PageHeader
        title={data.name}
        backTo={{ to: connectionsPath, label: t(`${kind}.backToConnections`) }}
        actions={
          <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => setEditing(true)}>
            {t("common.action.edit")}
          </Button>
        }
      />
      <Box maw={CONTENT_MAX_WIDTH}>
        <Stack gap="xl">{sections(data, connection.dataUpdatedAt)}</Stack>
      </Box>
      {editing && (
        <Editor
          target={data}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await refreshQueriesAfterMutation(queryClient, [kind]);
          }}
        />
      )}
    </Stack>
  );
}
