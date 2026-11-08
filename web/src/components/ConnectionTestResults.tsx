import type { ParseKeys, TFunction } from "i18next";
import { Alert, Badge, Stack, Table, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { FlowTestResult } from "../api/flow";
import type { JiraTestResult } from "../api/jira";
import type { SyncKind } from "../api/sync";
import { isSkipped, type TestRow } from "../utils/connectionTestRows";
import { errorCodeText } from "../utils/syncRuns";
import ScrollRegion from "./ScrollRegion";

/** The detail cell of a failed row: the upstream status, the failure in words (code kept visible) and the scope the probe needs. */
function rowDetail(row: TestRow, t: TFunction, kind: SyncKind): string {
  if (row.ok) return "—";
  if (isSkipped(row)) return t("sync.test.skippedDetail");
  const parts = [
    row.status != null ? String(row.status) : null,
    row.code ? errorCodeText(row.code, t, kind) : null,
    // Jira's hint is the scope the probe needs. Flow's hint ("Flow 1.57.0 or later") is already in its NOT_FOUND sentence, and a revoked
    // token or an outage must not talk about versions: Flow rows show none.
    row.scopeHint && kind === "JIRA" ? t("jira.test.scopeHint", { scope: row.scopeHint }) : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/** Green passed, neutral gray skipped (not run, no verdict of its own), red a failed required row, orange a failed optional one. */
function rowColor(row: TestRow): string {
  if (row.ok) return "green";
  if (isSkipped(row)) return "gray";
  return row.required ? "red" : "orange";
}

/**
 * Atlassian answers a scoped token that lacks a probe's scope with 401, not 403: one failing probe (a 401) next to a passing `myself`
 * therefore means a missing scope, not bad credentials. The note shows exactly then.
 */
function looksLikeMissingScope(rows: readonly TestRow[]): boolean {
  return rows.some((row) => row.name === "myself" && row.ok) && rows.some((row) => !row.ok && (row.status === 401 || row.code === "AUTHENTICATION_FAILED"));
}

/** The probes Flow's test runs, worded: the row's `name` is the wire id (`me`, `teams`, `stored_token`); an unknown one reads as itself. */
const FLOW_PROBE_LABELS = {
  me: "flow.probe.me",
  teams: "flow.probe.teams",
  stored_token: "flow.probe.stored_token",
} as const satisfies Record<string, ParseKeys>;

function probeLabel(row: TestRow, t: TFunction, kind: SyncKind): string {
  return kind === "FLOW" && Object.hasOwn(FLOW_PROBE_LABELS, row.name) ? t(FLOW_PROBE_LABELS[row.name as keyof typeof FLOW_PROBE_LABELS]) : row.name;
}

/** What a Flow test learned beyond its rows: the document's size, and whether Flow cut it at its caps. */
function FlowDocumentFacts({ result }: { result: FlowTestResult }) {
  const { t } = useTranslation();
  return (
    <>
      {result.teamCount != null && result.sprintCount != null && (
        <Text size="sm">{t("flow.test.document", { teams: result.teamCount, sprints: result.sprintCount })}</Text>
      )}
      {result.truncated && (
        <Alert color="orange" variant="light" role="note">
          {t("flow.test.truncated")}
        </Alert>
      )}
    </>
  );
}

/**
 * The Test-connection outcome table: one row per probed endpoint, in the order the server ran them. A passing row is GREEN (the success
 * colour), a failed REQUIRED row red (blocking), a failed optional one orange (a soft finding: it does not fail the test), a skipped one gray
 * (not run because `tenant_info` failed; the first failed row is the cause). Used by the
 * editor modal (the ad-hoc or stored probe) and the connection page (the stored probe). Ported from Flow's `ConnectionTestResults`.
 * Flow's result (`kind="FLOW"`, its `me` probe is the one that can skip `teams`) words the probes and codes the Flow way, has no scope note,
 * and adds the document's counts and the truncation note.
 */
export default function ConnectionTestResults(props: { result: JiraTestResult; kind?: "JIRA" } | { result: FlowTestResult; kind: "FLOW" }) {
  const { t } = useTranslation();
  const { result } = props;
  const kind: SyncKind = props.kind ?? "JIRA";
  return (
    <Stack gap="xs">
      <ScrollRegion label={t("sync.test.tableAria")} minWidth={640}>
        <Table aria-label={t("sync.test.tableAria")}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("sync.test.column.endpoint")}</Table.Th>
              <Table.Th>{t("sync.test.column.required")}</Table.Th>
              <Table.Th>{t("sync.test.column.result")}</Table.Th>
              <Table.Th>{t("sync.test.column.detail")}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {result.rows.map((row) => (
              <Table.Tr key={row.name}>
                <Table.Td>
                  <Text size="sm" fw={500}>
                    {probeLabel(row, t, kind)}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {row.path}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{row.required ? t("sync.test.required") : t("sync.test.optional")}</Text>
                </Table.Td>
                <Table.Td style={{ whiteSpace: "nowrap" }}>
                  <Badge color={rowColor(row)} variant="light" tt="none">
                    {row.ok ? t("sync.test.ok") : isSkipped(row) ? t("sync.test.skipped") : t("sync.test.failed")}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {rowDetail(row, t, kind)}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollRegion>
      {kind === "JIRA" && looksLikeMissingScope(result.rows) && (
        <Alert color="orange" variant="light" role="note">
          {t("jira.test.scopeNote")}
        </Alert>
      )}
      {props.kind !== "FLOW" && props.result.stub && (
        <Alert color="gray" variant="light" role="note">
          {t("jira.test.stubNote")}
        </Alert>
      )}
      {props.kind === "FLOW" ? (
        <FlowDocumentFacts result={props.result} />
      ) : (
        props.result.cloudId && (
          <Text size="xs" c="dimmed">
            {t("jira.test.cloudId", { cloudId: props.result.cloudId })}
          </Text>
        )
      )}
    </Stack>
  );
}
