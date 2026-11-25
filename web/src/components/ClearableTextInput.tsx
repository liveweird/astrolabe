import type { Ref } from "react";
import { CloseButton, TextInput } from "@mantine/core";
import { useTranslation } from "react-i18next";

/** The standard filter input: contains-placeholder (overridable) plus a one-click clear button. */
export default function ClearableTextInput({
  label,
  value,
  onChange,
  clearLabel,
  placeholder,
  disabled = false,
  hideLabel = false,
  inputRef,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  clearLabel: string;
  placeholder?: string;
  disabled?: boolean;
  /** A toolbar search: the label becomes the input's accessible name and is not drawn (the placeholder says what it is). */
  hideLabel?: boolean;
  /** The input element, for a caller that moves the focus here. */
  inputRef?: Ref<HTMLInputElement>;
  maxLength?: number;
}) {
  const { t } = useTranslation();
  return (
    <TextInput
      ref={inputRef}
      maxLength={maxLength}
      label={hideLabel ? undefined : label}
      aria-label={hideLabel ? label : undefined}
      placeholder={placeholder ?? t("common.filter.contains")}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.currentTarget.value)}
      rightSection={
        value ? (
          <CloseButton
            size="sm"
            aria-label={clearLabel}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange("")}
            disabled={disabled}
          />
        ) : null
      }
      rightSectionPointerEvents="auto"
    />
  );
}
