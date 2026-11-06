import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { Box, Button, Stack } from "@mantine/core";
import { IconPencil } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/http";
import { getJiraConnection } from "../api/jira";
import { useAdmin } from "../auth";
import EditPageLoadState from "../components/EditPageLoadState";
import JiraConnectionEditorModal from "../components/JiraConnectionEditorModal";
import JiraBindingsSection from "../components/JiraBindingsSection";
import JiraConnectionSection from "../components/JiraConnectionSection";
import JiraMappingSection from "../components/JiraMappingSection";
import PageHeader from "../components/PageHeader";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { jiraConnectionsPath } from "../utils/jiraLinks";
import { CONTENT_MAX_WIDTH } from "../utils/layout";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import { loadErrorMessage } from "../utils/saveError";

/**
 * One Jira connection (`/integrations/jira/:id`, ADMIN only): the Connection section (facts, Test connection, Refresh now, the runs) and the
 * Mapping section (discovery report, the field mapping, Peek) and the Bindings section (the plan items linked through it, Unlink, "Link a node…").
 */
export default function JiraConnectionDetails() {
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

  const connection = useQuery({ queryKey: ["jira", "connection", id], queryFn: () => getJiraConnection(id), enabled: idIsValid && admin });

  if (!idIsValid || connection.isLoading || connection.isError || !connection.data) {
    const notFound = !idIsValid || (connection.error instanceof ApiError && connection.error.status === 404);
    return (
      <EditPageLoadState
        isLoading={idIsValid && connection.isLoading}
        message={notFound ? t("jira.notFound") : loadErrorMessage(connection.error, t)}
        backTo={jiraConnectionsPath}
        backLabel={t("jira.backToConnections")}
        title={t("jira.title")}
      />
    );
  }
  const data = connection.data;

  return (
    <Stack gap="md">
      <PageHeader
        title={data.name}
        backTo={{ to: jiraConnectionsPath, label: t("jira.backToConnections") }}
        actions={
          <Button variant="default" leftSection={<IconPencil size={16} />} onClick={() => setEditing(true)}>
            {t("common.action.edit")}
          </Button>
        }
      />
      <Box maw={CONTENT_MAX_WIDTH}>
        <Stack gap="xl">
          <JiraConnectionSection connection={data} />
          <JiraMappingSection connection={data} />
          <JiraBindingsSection connection={data} />
        </Stack>
      </Box>
      {editing && (
        <JiraConnectionEditorModal
          target={data}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await refreshQueriesAfterMutation(queryClient, ["jira"]);
          }}
        />
      )}
    </Stack>
  );
}
