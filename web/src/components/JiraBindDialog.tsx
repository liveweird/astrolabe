import { useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, Anchor, Button, Group, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import type { DeviationConnection } from "../api/deviations";
import { createJiraBinding, type JiraLevel } from "../api/jira";
import { useAdmin } from "../auth";
import { ISSUE_KEY_PATTERN } from "../utils/jiraForm";
import { bindFailure, type BindFailure } from "../utils/jiraBind";
import { jiraConnectionsPath } from "../utils/jiraLinks";
import { showSuccessToast } from "../utils/toast";
import FormErrorAlert from "./FormErrorAlert";
import JiraBindNodePicker from "./JiraBindNodePicker";
import type { PickedOption } from "./SearchPicker";

/** A plan node the dialog is aimed at in advance (the project page's header and milestone rows): the node picker is skipped. */
export type BindTarget = { level: JiraLevel; id: number; name: string };

/** Where the dialog's connections come from: the page's own (the connection page) or the chip query's `connections[]` (the project page); null = not known (yet, or the query failed). */
export type BindSource = { connections: readonly DeviationConnection[] | null; failed: boolean; retry: () => void };

const LEVELS: readonly JiraLevel[] = ["PROJECT", "MILESTONE", "PROGRAM"];

/**
 * Link one plan node to one Jira issue (`POST /integrations/jira/bindings`). It works for a plan OWNER who is no administrator: the Jira
 * connections come from `GET /views/deviations` `connections[]` (the registry is ADMIN only) and only enabled ones are offered - with
 * exactly one, it is preselected; one whose mapping does not fit the site (`mappingOk: false`) is marked and refuses the link in words.
 * `target` fixes the node (the project page); otherwise a level select and a picker choose it. `connectionId` fixes the connection (the
 * connection page). It asks for nothing itself: `source` is what the page already has - on the project page the chip query's `connections[]`; when that
 * query failed (or has not answered) the dialog says so and offers a retry. Every failure is an inline alert with the entered key kept (`bindFailure`); nothing is ever only a toast.
 */
export default function JiraBindDialog({
  target = null,
  source,
  connectionId,
  onClose,
  onBound,
}: {
  target?: BindTarget | null;
  source: BindSource;
  connectionId?: number;
  onClose: () => void;
  onBound: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const admin = useAdmin();
  const [chosenConnection, setChosenConnection] = useState<string | null>(null);
  const [chosenLevel, setChosenLevel] = useState<JiraLevel>("PROJECT");
  const [picked, setPicked] = useState<PickedOption | null>(null);
  const [issueKey, setIssueKey] = useState("");
  const [fieldError, setFieldError] = useState<{ key?: string; node?: string }>({});
  const [failure, setFailure] = useState<BindFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const offered = (source.connections ?? []).filter((connection) => connection.enabled && (connectionId === undefined || connection.id === connectionId));
  const selected = offered.find((connection) => String(connection.id) === (chosenConnection ?? (offered.length === 1 ? String(offered[0].id) : null))) ?? null;
  const level = target?.level ?? chosenLevel;

  async function submit() {
    if (submitting) return;
    const key = issueKey.trim().toUpperCase();
    const errors = {
      key: ISSUE_KEY_PATTERN.test(key) ? undefined : t("jira.bind.keyInvalid"),
      node: target !== null || picked !== null ? undefined : t("jira.bind.nodeRequired"),
    };
    setFieldError(errors);
    setFailure(null);
    const nodeId = target?.id ?? (picked === null ? null : Number(picked.value));
    if (errors.key !== undefined || errors.node !== undefined || selected === null || nodeId === null) return;
    setSubmitting(true);
    try {
      await createJiraBinding({ connectionId: selected.id, level, nodeId, issueKey: key });
      showSuccessToast(t("jira.toast.bound"));
      await onBound();
    } catch (err) {
      setFailure(bindFailure(err, t));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      closeButtonProps={{ "aria-label": t("common.action.close") }}
      // While the request is in flight the dialog stays: closing it would hide the outcome of a link that still lands.
      withCloseButton={!submitting}
      closeOnEscape={!submitting}
      closeOnClickOutside={!submitting}
      opened
      onClose={onClose}
      title={t("jira.bind.title")}
      centered
    >
      <Stack>
        <Text size="sm" c="dimmed">
          {t("jira.bind.intro")}
        </Text>
        {source.connections === null ? (
          source.failed ? (
            <Stack gap="xs" align="flex-start">
              <FormErrorAlert>{t("jira.bind.loadFailed")}</FormErrorAlert>
              <Button variant="default" size="xs" onClick={source.retry}>
                {t("jira.bind.retry")}
              </Button>
            </Stack>
          ) : (
            <Text size="sm">{t("jira.bind.loading")}</Text>
          )
        ) : offered.length === 0 ? (
          <NoConnection configured={source.connections.length > 0} admin={admin} onClose={onClose} />
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            noValidate
          >
            <Stack>
              <Select
                label={t("jira.bind.connection")}
                data={offered.map((connection) => ({ value: String(connection.id), label: connection.mappingOk ? connection.name : t("jira.bind.connectionMappingMark", { name: connection.name }) }))}
                value={selected === null ? null : String(selected.id)}
                onChange={setChosenConnection}
                allowDeselect={false}
                readOnly={offered.length === 1}
              />
              {selected === null && (
                <Text size="xs" role="note">
                  {t("jira.bind.pickConnection")}
                </Text>
              )}
              {selected !== null && !selected.mappingOk && (
                <Alert color="orange" variant="light" role="note">
                  {t("jira.bind.mappingNote")}
                </Alert>
              )}
              {target === null ? (
                <>
                  <Select
                    label={t("jira.bind.level")}
                    data={LEVELS.map((value) => ({ value, label: t(`jira.mapping.level.${value.toLowerCase() as "program" | "project" | "milestone"}`) }))}
                    value={chosenLevel}
                    onChange={(value) => {
                      setChosenLevel((value ?? "PROJECT") as JiraLevel);
                      setPicked(null);
                      setFieldError((previous) => ({ ...previous, node: undefined }));
                    }}
                    allowDeselect={false}
                  />
                  <JiraBindNodePicker level={level} picked={picked} onPick={setPicked} error={fieldError.node} />
                </>
              ) : (
                <TextInput label={t("jira.bind.planItem")} value={target.name} readOnly />
              )}
              <TextInput
                label={t("jira.bind.issueKey")}
                description={t("jira.bind.issueKeyHint")}
                placeholder="ABC-12"
                maxLength={21}
                value={issueKey}
                onChange={(event) => setIssueKey(event.currentTarget.value)}
                error={fieldError.key}
                data-autofocus
              />
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
              <Group justify="flex-end" gap="sm">
                <Button type="button" variant="default" onClick={onClose} disabled={submitting}>
                  {t("common.action.cancel")}
                </Button>
                <Button type="submit" loading={submitting} disabled={selected === null || !selected.mappingOk}>
                  {t("jira.bind.submit")}
                </Button>
              </Group>
            </Stack>
          </form>
        )}
      </Stack>
    </Modal>
  );
}

/** No connection to link through: none set up at all, or every one disabled. Says plainly what to do, and for a non-admin who has to do it. */
function NoConnection({ configured, admin, onClose }: { configured: boolean; admin: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert color="gray" variant="light" role="note">
      <Text size="sm">{configured ? t("jira.bind.allDisabled") : t("jira.bind.noConnections")}</Text>
      {!configured && (
        <Text size="sm" mt={4}>
          {admin ? (
            <Anchor component={RouterLink} to={jiraConnectionsPath} onClick={onClose}>
              {t("jira.bind.noConnectionsAdmin")}
            </Anchor>
          ) : (
            t("jira.bind.noConnectionsUser")
          )}
        </Text>
      )}
    </Alert>
  );
}
