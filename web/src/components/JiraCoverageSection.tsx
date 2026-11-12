import { useTranslation } from "react-i18next";
import { Alert, Stack, Table, Text, Title } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { getJiraCoverage, type JiraConnection, type JiraCoverage } from "../api/jira";
import { formatDateTime } from "../utils/formatDate";
import ErrorAlert from "./ErrorAlert";
import LoadingBlock from "./LoadingBlock";

const levelWord = (kind: JiraCoverage["levels"][number]["level"]) => `jira.mapping.level.${kind.toLowerCase() as "program" | "project" | "milestone"}` as const;

/**
 * The connection page's Coverage section (1.14): per mapped level, how many of the site's issues are in scope (the census the runs keep), how
 * many an active binding links and how many are open and unlinked. Counts only, read from the server at request time; before the first
 * synchronisation (or while the mapping cannot name the levels) it says so instead of showing zeros.
 */
export default function JiraCoverageSection({ connection }: { connection: JiraConnection }) {
  const { t } = useTranslation();
  const { data, isError, error } = useQuery({
    queryKey: ["jira", "coverage", connection.id],
    queryFn: () => getJiraCoverage(connection.id),
  });

  let body;
  if (isError) {
    body = <ErrorAlert error={error} title={t("jira.coverage.loadFailed")} />;
  } else if (!data) {
    body = <LoadingBlock />;
  } else if (data.state !== "READY") {
    body = (
      <Alert color="gray" variant="light" role="note" icon={<IconInfoCircle size={16} />}>
        {data.state === "NOT_SYNCED" ? t("jira.coverage.notSynced") : t("jira.coverage.mappingUnusable")}
      </Alert>
    );
  } else {
    body = (
      <>
        <Table aria-label={t("jira.coverage.tableAria")}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("jira.coverage.column.level")}</Table.Th>
              <Table.Th ta="right">{t("jira.coverage.column.inScope")}</Table.Th>
              <Table.Th ta="right">{t("jira.coverage.column.linked")}</Table.Th>
              <Table.Th ta="right">{t("jira.coverage.column.openUnlinked")}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.levels.map((row) => (
              <Table.Tr key={row.level}>
                <Table.Th scope="row" fw={500}>
                  {t(levelWord(row.level))}
                </Table.Th>
                <Table.Td ta="right">{row.inScope}</Table.Td>
                <Table.Td ta="right">{row.linked}</Table.Td>
                <Table.Td ta="right">{row.openUnlinked}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {data.censusAt !== null && (
          <Text size="xs" c="dimmed">
            {t("jira.coverage.asOf", { when: formatDateTime(data.censusAt) })}
          </Text>
        )}
      </>
    );
  }

  return (
    <Stack gap="md">
      <Title order={3} size="h4">
        {t("jira.coverage.title")}
      </Title>
      <Text size="sm" c="dimmed">
        {t("jira.coverage.intro")}
      </Text>
      {body}
    </Stack>
  );
}
