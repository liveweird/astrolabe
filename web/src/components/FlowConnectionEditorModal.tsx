import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button, Modal, PasswordInput, Stack, Switch, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { ApiError } from "../api/http";
import {
  createFlowConnection,
  getFlowOrigins,
  testFlowConnection,
  testFlowConnectionAdHoc,
  updateFlowConnection,
  type FlowConnection,
  type FlowTestResult,
} from "../api/flow";
import {
  allowedOriginsHint,
  canonicalTimeZone,
  clearsVerdict,
  EMPTY_FLOW_FORM,
  flowFormValidation,
  flowSaveErrorMessage,
  flowTestErrorMessage,
  fromFlowConnection,
  MAX_FLOW_CONNECTION_NAME_LENGTH,
  normaliseBaseUrl,
  toFlowConnectionRequest,
  type FlowFormValues,
} from "../utils/flowForm";
import { showSuccessToast } from "../utils/toast";
import ConnectionTestResults from "./ConnectionTestResults";
import ConnectionTestStatus from "./ConnectionTestStatus";
import FormErrorAlert from "./FormErrorAlert";
import PollingFields from "./PollingFields";
import RegistryEditorActions from "./RegistryEditorActions";

/** The fields the server requires of a probe's body (the same shape as a create); the rest of the form may be incomplete. */
const PROBE_FIELDS = ["name", "baseUrl", "timeZone", "apiToken"] as const;
/** A Flow service token is `flow_int_` and 43 characters; the field takes a little more so a paste with whitespace is not cut. */
const MAX_TOKEN_FIELD_LENGTH = 200;

/**
 * Create (target null) / edit (target set) a Flow connection, in one modal (the registry shape; the Jira editor's twin). The base URL is the
 * connection's identity: read-only once it exists (a PUT with another one is a 409), and it is written canonically for you (lowercase, no
 * default port, no trailing slash - the only spelling the server stores); whether it is one the OPERATOR listed is the server's 400. The
 * time zone is pre-filled with Flow's own (`Europe/Warsaw`) and checked against the engine's zone list. The service token is WRITE-ONLY -
 * never pre-filled, shown or logged; on edit a blank field keeps the stored token. Test connection probes with the form's values (an ad-hoc
 * call, the token in the body) unless editing with a blank token, which probes the STORED connection.
 */
export default function FlowConnectionEditorModal({
  target,
  onClose,
  onSaved,
}: {
  target: FlowConnection | null;
  onClose: () => void;
  onSaved: (saved: FlowConnection | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<ReactNode>(null);
  const [testResult, setTestResult] = useState<FlowTestResult | null>(null);

  const isEdit = target !== null;
  // `hasApiToken` is all the server ever says about the token: "leave blank to keep" only when one is stored.
  const tokenHint = !isEdit ? t("flow.field.apiTokenHint") : target.hasApiToken ? t("flow.field.apiTokenKeep") : t("flow.field.apiTokenMissing");
  // The operator's list, asked on create only (an existing connection's address is fixed); a failed or pending read shows the plain hint.
  const origins = useQuery({ queryKey: ["flow", "origins"], queryFn: getFlowOrigins, enabled: !isEdit });
  const baseUrlHint = isEdit ? t("flow.field.baseUrlFixed") : allowedOriginsHint(t("flow.field.baseUrlHint"), origins.data?.items, t);
  const form = useForm<FlowFormValues>({
    initialValues: target ? fromFlowConnection(target) : EMPTY_FLOW_FORM,
    validate: flowFormValidation(t, isEdit),
  });

  async function save(values: FlowFormValues) {
    setError(null);
    setSubmitting(true);
    try {
      let saved: FlowConnection | null = null;
      if (target) {
        await updateFlowConnection(target.id, toFlowConnectionRequest(values));
        // A new token or time zone clears the last verdict (the server's rule): say it is time to test again.
        showSuccessToast(t(clearsVerdict(values, target) ? "flow.toast.savedRetest" : "flow.toast.saved"));
      } else {
        saved = await createFlowConnection(toFlowConnectionRequest(values));
        showSuccessToast(t("flow.toast.created"));
      }
      await onSaved(saved);
    } catch (err) {
      // The 409 is about THIS control (the case-insensitive name clash) - mark the field.
      if (err instanceof ApiError && err.status === 409) {
        form.setFieldError("name", t("flow.saveConflict"));
      } else if (err instanceof ApiError && err.status === 400 && err.detail) {
        // The server's own sentence says which rule (it never quotes the token or the rejected address): shown under the fixed lead.
        setError(
          <>
            <Text size="sm">{flowSaveErrorMessage(err, t)}</Text>
            <Text size="sm" mt={4}>
              {err.detail}
            </Text>
          </>,
        );
      } else {
        setError(flowSaveErrorMessage(err, t));
      }
      setSubmitting(false);
    }
  }

  /** Validates only the fields the probe needs - the rest of the form may be incomplete. */
  function probeFieldsValid(): boolean {
    const rules = flowFormValidation(t, isEdit);
    const messages = PROBE_FIELDS.map((field) => {
      const message = rules[field](form.values[field]);
      form.setFieldError(field, message ?? undefined);
      return message;
    });
    return messages.every((message) => !message);
  }

  async function runTest() {
    // A stale result must never sit under a new attempt (or a new error).
    setTestError(null);
    setTestResult(null);
    if (!probeFieldsValid()) return;
    setTesting(true);
    try {
      // Editing with the token left blank probes the STORED connection with its stored (decrypted) token.
      const stored = target !== null && form.values.apiToken.trim() === "";
      const result = stored ? await testFlowConnection(target.id) : await testFlowConnectionAdHoc(toFlowConnectionRequest(form.values));
      setTestResult(result);
      // A stored test records the verdict on the connection: the pages that show it follow.
      if (stored) void queryClient.invalidateQueries({ queryKey: ["flow"] });
    } catch (err) {
      // A 400 carries the server's own sentence (an origin the operator did not list, a malformed token...): shown under the fixed lead, as a save does.
      const lead = flowTestErrorMessage(err, t);
      setTestError(
        err instanceof ApiError && err.status === 400 && err.detail ? (
          <>
            <Text size="sm">{lead}</Text>
            <Text size="sm" mt={4}>
              {err.detail}
            </Text>
          </>
        ) : (
          lead
        ),
      );
    } finally {
      setTesting(false);
    }
  }

  const baseUrlProps = form.getInputProps("baseUrl");
  const zoneProps = form.getInputProps("timeZone");

  return (
    <Modal
      closeButtonProps={{ "aria-label": t("common.action.close") }}
      opened
      onClose={onClose}
      title={isEdit ? t("flow.editTitle") : t("flow.createTitle")}
      size="lg"
      centered
    >
      <form onSubmit={form.onSubmit(save)} noValidate>
        <Stack>
          <TextInput label={t("common.field.name")} maxLength={MAX_FLOW_CONNECTION_NAME_LENGTH} data-autofocus {...form.getInputProps("name")} />
          <TextInput
            label={t("flow.field.baseUrl")}
            description={baseUrlHint}
            placeholder="https://flow.example.com"
            readOnly={isEdit}
            autoComplete="off"
            {...baseUrlProps}
            // Written the canonical way when the field is left, so what the admin sees is what the server will compare.
            onBlur={(event) => {
              if (!isEdit) form.setFieldValue("baseUrl", normaliseBaseUrl(event.currentTarget.value));
              baseUrlProps.onBlur(event);
            }}
          />
          <TextInput
            label={t("flow.field.timeZone")}
            description={t("flow.field.timeZoneHint")}
            autoComplete="off"
            {...zoneProps}
            // Written the canonical way when the field is left (`europe/warsaw` -> `Europe/Warsaw`): the server compares the exact id.
            onBlur={(event) => {
              const canonical = canonicalTimeZone(event.currentTarget.value);
              if (canonical !== null) form.setFieldValue("timeZone", canonical);
              zoneProps.onBlur(event);
            }}
          />
          <PasswordInput
            label={t("flow.field.apiToken")}
            description={tokenHint}
            maxLength={MAX_TOKEN_FIELD_LENGTH}
            autoComplete="new-password"
            {...form.getInputProps("apiToken")}
          />
          <Switch label={t("flow.field.enabled")} {...form.getInputProps("enabled", { type: "checkbox" })} />
          <PollingFields form={form} hint={t("flow.field.pollIntervalHint")} />

          <Button type="button" variant="default" loading={testing} onClick={() => void runTest()}>
            {t("flow.testConnection")}
          </Button>
          <ConnectionTestStatus result={testResult} />
          {testError && <FormErrorAlert>{testError}</FormErrorAlert>}
          {testResult && <ConnectionTestResults result={testResult} kind="FLOW" />}

          <RegistryEditorActions error={error} submitting={submitting} isEdit={isEdit} onClose={onClose} gap="sm" />
        </Stack>
      </form>
    </Modal>
  );
}
