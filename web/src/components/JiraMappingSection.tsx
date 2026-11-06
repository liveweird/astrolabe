import { useTranslation } from "react-i18next";
import { Alert, Stack, Title } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJiraDiscovery, getJiraMapping, isJiraNotDiscovered, type JiraConnection } from "../api/jira";
import { refreshQueriesAfterMutation } from "../utils/queryRefresh";
import ErrorAlert from "./ErrorAlert";
import JiraDiscoveryReport from "./JiraDiscoveryReport";
import JiraMappingEditor from "./JiraMappingEditor";
import JiraPeek from "./JiraPeek";
import LoadingBlock from "./LoadingBlock";

/**
 * The connection page's Mapping section: the discovery report (what the stored snapshot holds and which assumption markers were or were
 * not found), the mapping editor and Peek. Everything here rests on the discovery a stored Test connection stores, so before one exists
 * the section says "Test the connection first" instead of showing an empty form.
 */
export default function JiraMappingSection({ connection }: { connection: JiraConnection }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const discovered = connection.discoveredAt !== null;
  // Both reads are keyed by the discovery they belong to: a Test connection that stores a new one starts FRESH reads (the mapping's
  // `defaults` are null until a discovery exists, so a copy fetched before it must never open the editor on an empty form).
  const discovery = useQuery({
    queryKey: ["jira", "discovery", connection.id, connection.discoveredAt],
    queryFn: () => getJiraDiscovery(connection.id),
    enabled: discovered,
  });
  const mapping = useQuery({ queryKey: ["jira", "mapping", connection.id, connection.discoveredAt], queryFn: () => getJiraMapping(connection.id) });

  let body;
  if (!discovered || isJiraNotDiscovered(discovery.error)) {
    body = (
      <Alert color="gray" variant="light" role="note" icon={<IconInfoCircle size={16} />}>
        {t("jira.mapping.testFirst")}
      </Alert>
    );
  } else if (discovery.isError || mapping.isError) {
    body = <ErrorAlert error={discovery.error ?? mapping.error} title={t("jira.mapping.loadFailed")} />;
  } else if (!discovery.data || !mapping.data) {
    body = <LoadingBlock />;
  } else {
    body = (
      <>
        <Stack gap="xs">
          <Title order={4} size="h5">
            {t("jira.report.title")}
          </Title>
          <JiraDiscoveryReport discovery={discovery.data} />
        </Stack>
        <Stack gap="xs">
          <Title order={4} size="h5">
            {t("jira.mapping.fieldsTitle")}
          </Title>
          <JiraMappingEditor
            // A new discovery or a saved mapping re-opens the form on what is now stored.
            key={`${discovery.data.discoveredAt}:${mapping.data.discoveredAt}:${JSON.stringify(mapping.data.mapping)}`}
            connectionId={connection.id}
            discovery={discovery.data}
            response={mapping.data}
            onSaved={() => refreshQueriesAfterMutation(queryClient, ["jira"])}
          />
        </Stack>
        <Stack gap="xs">
          <Title order={4} size="h5">
            {t("jira.peek.title")}
          </Title>
          <JiraPeek connectionId={connection.id} siteUrl={connection.siteUrl} resetKey={`${discovery.data.discoveredAt}:${JSON.stringify(mapping.data.mapping)}`} />
        </Stack>
      </>
    );
  }

  return (
    <Stack gap="md">
      <Title order={3} size="h4">
        {t("jira.details.mappingSection")}
      </Title>
      {body}
    </Stack>
  );
}
