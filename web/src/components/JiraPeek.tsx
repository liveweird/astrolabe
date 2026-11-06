import { useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Button, Group, Stack, Table, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMutation } from "@tanstack/react-query";
import { ApiError } from "../api/http";
import { isJiraNotDiscovered, isJiraTokenUnreadable, peekJiraIssue, type JiraPeekResponse } from "../api/jira";
import { ISSUE_KEY_PATTERN } from "../utils/jiraForm";
import { errorCodeText } from "../utils/syncRuns";
import FormErrorAlert from "./FormErrorAlert";
import JiraKeyLink from "./JiraKeyLink";
import ScrollRegion from "./ScrollRegion";

const MAX_RAW_CHARS = 1000;

/** A raw field value as text: a string as is, anything else as JSON, clamped. It is only ever rendered as a text node, never as HTML. */
function rawText(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > MAX_RAW_CHARS ? `${text.slice(0, MAX_RAW_CHARS)}…` : text;
}

/** An inline failure of a Peek in words: the 400 with the server's own sentence (it says which rule), the 409s by problem type, the 502 with Jira's failure code. */
function peekFailure(err: unknown, t: TFunction): { message: string; detail?: string } {
  if (isJiraNotDiscovered(err)) return { message: t("jira.peek.notDiscovered") };
  if (isJiraTokenUnreadable(err)) return { message: t("jira.peek.tokenUnreadable") };
  if (err instanceof ApiError) {
    if (err.status === 400) return { message: t("jira.peek.invalid"), detail: err.detail };
    if (err.status === 404) return { message: t("jira.peek.notFound") };
    if (err.status === 429) return { message: t("jira.test.rateLimited") };
    if (err.status === 502) {
      // The detail is "Jira did not answer (AUTHENTICATION_FAILED)": only the code is lifted out and put in words.
      const code = /\(([A-Z_]+)\)/.exec(err.detail ?? "")?.[1];
      return { message: t("jira.peek.upstream"), detail: code ? errorCodeText(code, t) : undefined };
    }
    if (err.status === 403) return { message: t("jira.saveForbidden") };
    return { message: t("common.error.actionFailedStatus", { status: err.status }) };
  }
  return { message: t("common.error.actionFailed") };
}

function ResultTable({ result, siteUrl }: { result: JiraPeekResponse; siteUrl: string }) {
  const { t } = useTranslation();
  const { issue, resolved } = result;
  const dash = "—";
  const raw = Object.entries(result.raw);
  const label = t("jira.peek.resultAria");
  const group = (key: string, title: string) => (
    <Table.Tr key={`group-${key}`}>
      <Table.Th colSpan={2} scope="colgroup">
        {title}
      </Table.Th>
    </Table.Tr>
  );
  const row = (key: string, name: string, value: ReactNode) => (
    <Table.Tr key={key}>
      <Table.Td w="32%">
        <Text size="sm">{name}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm" component="div" style={{ overflowWrap: "anywhere" }}>
          {value}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
  return (
    <ScrollRegion label={label} minWidth={420}>
      <Table aria-label={label}>
        <Table.Tbody>
          {group("issue", t("jira.peek.issue"))}
          {row("key", t("jira.peek.key"), <JiraKeyLink issueKey={issue.key} siteUrl={siteUrl} underline="always" />)}
          {row("summary", t("jira.peek.summary"), issue.summary ?? dash)}
          {row("type", t("jira.peek.type"), issue.typeName ?? dash)}
          {row("level", t("jira.peek.hierarchyLevel"), issue.hierarchyLevel ?? dash)}
          {row("status", t("jira.peek.statusCategory"), t(`jira.peek.status.${issue.statusCategory}`))}
          {row("parent", t("jira.peek.parent"), issue.parentKey ?? dash)}
          {group("resolved", t("jira.peek.resolved"))}
          {row("rlevel", t("jira.peek.planLevel"), resolved.level ? t(`jira.mapping.level.${resolved.level.toLowerCase() as "program" | "project" | "milestone"}`) : t("jira.peek.noLevel"))}
          {row("start", t("jira.peek.start"), resolved.start ?? dash)}
          {row("end", t("jira.peek.end"), resolved.end ?? dash)}
          {row("estimate", t("jira.peek.estimate"), resolved.estimate == null ? dash : `${resolved.estimate} ${t(`jira.mapping.unitOption.${resolved.unit}`)}`)}
          {row("team", t("jira.peek.team"), resolved.teamName ?? dash)}
          {group("raw", t("jira.peek.raw"))}
          {raw.length === 0
            ? row("raw-none", dash, t("jira.peek.rawNone"))
            : raw.map(([fieldId, value]) => row(`raw-${fieldId}`, fieldId, <code>{rawText(value)}</code>))}
        </Table.Tbody>
      </Table>
    </ScrollRegion>
  );
}

/**
 * Peek: reads ONE issue through the saved mapping (else the defaults) and shows what the mapping makes of it - the cheapest way to see what
 * a real site sends before anything is linked. A key field with the issue-key pattern check, then the issue's system fields, the values
 * the mapping resolves and the mapped fields' raw values (arbitrary JSON, rendered as text only). Failures stay inline. Not stored.
 * What it shows belongs to the mapping it was read under: when `resetKey` (the saved mapping and discovery) changes, a result or an error
 * from before is hidden (the typed key stays, so the same issue can be read again).
 */
export default function JiraPeek({ connectionId, siteUrl, resetKey }: { connectionId: number; siteUrl: string; resetKey: string }) {
  const { t } = useTranslation();
  const form = useForm({
    initialValues: { key: "" },
    validate: { key: (value) => (ISSUE_KEY_PATTERN.test(value.trim().toUpperCase()) ? null : t("jira.peek.keyInvalid")) },
  });
  const [ranUnder, setRanUnder] = useState<string | null>(null);
  const peek = useMutation({ mutationFn: (key: string) => peekJiraIssue(connectionId, key), onMutate: () => setRanUnder(resetKey) });
  const current = ranUnder === resetKey;
  const failure = peek.isError && current ? peekFailure(peek.error, t) : null;

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {t("jira.peek.keyHint")}
      </Text>
      <form onSubmit={form.onSubmit((values) => peek.mutate(values.key.trim().toUpperCase()))} noValidate>
        <Group align="flex-start" gap="sm" wrap="wrap">
          <TextInput
            label={t("jira.peek.keyLabel")}
            placeholder="ABC-12"
            maxLength={21}
            w={260}
            {...form.getInputProps("key")}
          />
          <Button type="submit" variant="default" loading={peek.isPending} mt={25}>
            {t("jira.peek.run")}
          </Button>
        </Group>
      </form>
      {failure && (
        <FormErrorAlert>
          <Text size="sm">{failure.message}</Text>
          {failure.detail && (
            <Text size="sm" mt={4}>
              {failure.detail}
            </Text>
          )}
        </FormErrorAlert>
      )}
      {peek.data && current && <ResultTable result={peek.data} siteUrl={siteUrl} />}
    </Stack>
  );
}
