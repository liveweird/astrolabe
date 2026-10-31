import { DateInput, type DateInputProps } from "@mantine/dates";
import { useTranslation } from "react-i18next";

/**
 * The plan's one date control: a Mantine `DateInput` over `YYYY-MM-DD` strings (the wire format, so no Date objects and no
 * time zones), typed or picked, shown as the same ISO text in both languages (the placeholder is `common.dateFormatHint`).
 * The label is required text: it also names the clear button ("Clear End date"), which Mantine leaves unnamed.
 */
export default function PlanDateInput(props: DateInputProps & { label: string }) {
  const { t } = useTranslation();
  return (
    <DateInput
      valueFormat="YYYY-MM-DD"
      placeholder={t("common.dateFormatHint")}
      clearButtonProps={{ "aria-label": t("plan.clearDateAria", { field: props.label }) }}
      {...props}
    />
  );
}
