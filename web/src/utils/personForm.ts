import type { TFunction } from "i18next";
import type { PersonCreateBody, PersonResponse, PersonUpdateBody } from "../api/people";
import { nameRule } from "./formRules";
import { saveErrorMessage } from "./saveError";

// Server limits (people/Person.kt) mirrored client-side.
export const MAX_PERSON_NAME_LENGTH = 100;
export const MAX_PERSON_EMAIL_LENGTH = 254;

export type PersonFormValues = {
  name: string;
  email: string;
  /** The picked login's user id (a string, the Select's value type); null = no login. */
  userId: string | null;
  /** The picked login's display label, kept beside the id so it survives later searches. */
  userLabel: string | null;
};

export const EMPTY_PERSON_FORM: PersonFormValues = { name: "", email: "", userId: null, userLabel: null };

/**
 * [loginLabel] is the picker's own option format (`name (email)`), resolved by the editor from the linked user: the person
 * response carries only the login's email, so without it the bare email labels the pick.
 */
export function toPersonFormValues(person: PersonResponse, loginLabel: string | null = null): PersonFormValues {
  return {
    name: person.name,
    email: person.email ?? "",
    userId: person.userId === null ? null : String(person.userId),
    userLabel: person.userId === null ? null : (loginLabel ?? person.userEmail),
  };
}

/** Validation rules shared by the create and edit modal (mirrors the server's checks). */
export function personFormValidation(t: TFunction) {
  return {
    name: nameRule(t, "people.validation.nameLength", MAX_PERSON_NAME_LENGTH),
    email: (value: string) => {
      const v = value.trim();
      if (v === "") return null;
      if (v.length > MAX_PERSON_EMAIL_LENGTH) return t("people.validation.emailLength");
      return v.includes("@") ? null : t("people.validation.emailShape");
    },
  };
}

/**
 * The wire body: a blank email travels as null (the server stores NULL, never ""); a PUT is a full replace, so no
 * login is an explicit null.
 */
export function toPersonBody(values: PersonFormValues): PersonCreateBody & PersonUpdateBody {
  const email = values.email.trim();
  return {
    name: values.name.trim(),
    email: email === "" ? null : email,
    userId: values.userId === null ? null : Number(values.userId),
  };
}

/** The person save vocabulary — 409 is about the email or login field and is handled by the caller. */
export function personSaveErrorMessage(err: unknown, t: TFunction): string {
  return saveErrorMessage(err, t, {
    forbidden: "people.saveForbidden",
    notFound: "people.saveGone",
    invalid: "people.saveInvalid",
    failedStatus: "common.error.saveFailedStatus",
    failed: "common.error.saveFailedNetwork",
  });
}
