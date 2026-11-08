import { Checkbox, Fieldset, NumberInput, Stack } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { MAX_POLL_INTERVAL_MINUTES, MIN_POLL_INTERVAL_MINUTES, type PollingValues } from "../utils/pollingForm";

/** The slice of a Mantine `useForm` this fieldset drives: both connection editors' form values extend {@link PollingValues}. */
type PollingForm = {
  values: PollingValues;
  getInputProps(path: "pollIntervalMinutes"): object;
  getInputProps(path: "manualOnly", options: { type: "checkbox" }): object;
  setFieldValue(path: "manualOnly", value: boolean): void;
  clearFieldError(path: "pollIntervalMinutes"): void;
};

/**
 * The connection editors' **Polling** fieldset (extracted from the Jira editor, shared with the Flow one): a `NumberInput` 5..1440 step 5
 * (`clampBehavior="none"`: a typed 3 or 2000 is refused with the rule's sentence, never clamped on blur) and a "Manual only (no polling)"
 * checkbox that disables it and makes the request carry an explicit `null`. `hint` is the connector's sentence under the number.
 */
export default function PollingFields({ form, hint }: { form: PollingForm; hint: string }) {
  const { t } = useTranslation();
  return (
    <Fieldset legend={t("common.polling.legend")}>
      <Stack gap="sm">
        <NumberInput
          label={t("common.polling.interval")}
          description={hint}
          min={MIN_POLL_INTERVAL_MINUTES}
          max={MAX_POLL_INTERVAL_MINUTES}
          step={5}
          clampBehavior="none"
          allowDecimal={false}
          allowNegative={false}
          disabled={form.values.manualOnly}
          {...form.getInputProps("pollIntervalMinutes")}
        />
        <Checkbox
          label={t("common.polling.manualOnly")}
          {...form.getInputProps("manualOnly", { type: "checkbox" })}
          onChange={(event) => {
            const manualOnly = event.currentTarget.checked;
            form.setFieldValue("manualOnly", manualOnly);
            // The number is not looked at any more: its refusal must not stay under the disabled input.
            if (manualOnly) form.clearFieldError("pollIntervalMinutes");
          }}
        />
      </Stack>
    </Fieldset>
  );
}
