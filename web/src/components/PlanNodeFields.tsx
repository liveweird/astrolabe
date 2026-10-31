import type { ReactNode } from "react";
import type { TextareaProps, TextInputProps } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { MAX_PLAN_DESCRIPTION_LENGTH, MAX_PLAN_NAME_LENGTH, type PlanNodeFormValues } from "../utils/planForm";
import PersonSelect from "./PersonSelect";
import RegistryMetadataFields from "./RegistryMetadataFields";

/**
 * The field block every plan editor starts with: name, description and the OWNER — a person of the people directory,
 * required on every node. `disabled` is the read-only look for a caller who may edit another part of the same modal (a roadmap
 * editor sets a project's target window but does not own the project).
 */
export default function PlanNodeFields({
  values,
  nameInputProps,
  descriptionInputProps,
  ownerError,
  onPickOwner,
  disabled,
}: {
  values: PlanNodeFormValues;
  nameInputProps: TextInputProps;
  descriptionInputProps: TextareaProps;
  ownerError?: ReactNode;
  onPickOwner: (picked: { value: string; label: string } | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <RegistryMetadataFields
        nameMaxLength={MAX_PLAN_NAME_LENGTH}
        descriptionMaxLength={MAX_PLAN_DESCRIPTION_LENGTH}
        descriptionLength={values.description.length}
        nameInputProps={{ ...nameInputProps, disabled }}
        descriptionInputProps={{ ...descriptionInputProps, disabled }}
      />
      <PersonSelect
        label={t("common.field.owner")}
        description={t("plan.ownerHint")}
        placeholder={t("plan.pickOwner")}
        clearLabel={t("plan.clearOwner")}
        picked={values.ownerPersonId !== null && values.ownerLabel !== null ? { value: values.ownerPersonId, label: values.ownerLabel } : null}
        onPick={onPickOwner}
        disabled={disabled}
        error={ownerError}
      />
    </>
  );
}
