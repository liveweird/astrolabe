import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Box, Button, Stack } from "@mantine/core";
import { IconPencil } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/http";
import { getFlowConnection } from "../api/flow";
import { useAdmin } from "../auth";
import EditPageLoadState from "../components/EditPageLoadState";
import FlowConnectionEditorModal from "../components/FlowConnectionEditorModal";
import FlowConnectionSection from "../components/FlowConnectionSection";
import FlowTeamsSection from "../components/FlowTeamsSection";
import PageHeader from "../components/PageHeader";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { flowConnectionsPath } from "../utils/flowLinks";
import { CONTENT_MAX_WIDTH } from "../utils/layout";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { loadErrorMessage } from "../utils/saveError";
import { IDLE_REFRESH_MS } from "../utils/syncRuns";

/**
 * One Flow connection (`/integrations/flow/:id`, ADMIN only): the Connection section (facts, Test connection, Refresh now, the runs) and the
 * Teams section (the mirrored Flow teams, their links to Astrolabe teams, "Link all suggested").
 */
export default function FlowConnectionDetails() {
  const { id: idParam } = useParams();
  // Keyed by the route's id: an in-place change of `:id` starts the page over (test result, editor, notes), never carries them across.
  return <ConnectionPage key={idParam} idParam={idParam} />;
}

function ConnectionPage({ idParam }: { idParam: string | undefined }) {
  const { t } = useTranslation();
  const id = Number(idParam);
  const idIsValid = Number.isInteger(id) && id > 0;
  const admin = useAdmin();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  useDialogFocus(editing);

  // Re-read slowly while the page is visible: the scheduler starts runs (and moves the status) without anyone clicking.
  const connection = useQuery({ queryKey: ["flow", "connection", id], queryFn: () => getFlowConnection(id), enabled: idIsValid && admin, refetchInterval: IDLE_REFRESH_MS });

  if (!idIsValid || connection.isLoading || connection.isError || !connection.data) {
    const notFound = !idIsValid || (connection.error instanceof ApiError && connection.error.status === 404);
    return (
      <EditPageLoadState
        isLoading={idIsValid && connection.isLoading}
        message={notFound ? t("flow.notFound") : loadErrorMessage(connection.error, t)}
        backTo={flowConnectionsPath}
        backLabel={t("flow.backToConnections")}
        title={t("flow.title")}
      />
    );
  }
  const data = connection.data;

  return (
    <Stack gap="md">
      <PageHeader
        title={data.name}
        backTo={{ to: flowConnectionsPath, label: t("flow.backToConnections") }}
        actions={
          <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => setEditing(true)}>
            {t("common.action.edit")}
          </Button>
        }
      />
      <Box maw={CONTENT_MAX_WIDTH}>
        <Stack gap="xl">
          <FlowConnectionSection connection={data} readAt={connection.dataUpdatedAt} />
          <FlowTeamsSection connection={data} />
        </Stack>
      </Box>
      {editing && (
        <FlowConnectionEditorModal
          target={data}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await refreshQueriesAfterMutation(queryClient, ["flow"]);
          }}
        />
      )}
    </Stack>
  );
}
