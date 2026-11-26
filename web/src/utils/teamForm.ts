import type { TFunction } from "i18next";
import type { TeamCreateBody, TeamResponse, TeamUpdateBody } from "../api/teams";
import { descriptionRule, nameRule } from "./formRules";
import { saveErrorMessage } from "./saveError";
import type { TeamColour } from "./teamColours";

// Server limits (teams/Team.kt) mirrored client-side.
export const MAX_TEAM_NAME_LENGTH = 100;
export const MAX_TEAM_DESCRIPTION_LENGTH = 500;

export type TeamFormValues = {
  name: string;
  description: string;
  /** The picked manager's person id (a string, the Select's value type); null = no manager. */
  managerPersonId: string | null;
  /** The picked manager's display label, kept beside the id so it survives later searches. */
  managerLabel: string | null;
  /** The picked colour; null on a NEW team until the user picks one (the editor then shows, and sends, the least-used colour once the teams are read). */
  colour: TeamColour | null;
};

export const EMPTY_TEAM_FORM: TeamFormValues = { name: "", description: "", managerPersonId: null, managerLabel: null, colour: null };

export function toTeamFormValues(team: TeamResponse): TeamFormValues {
  return {
    name: team.name,
    description: team.description ?? "",
    managerPersonId: team.managerPersonId === null ? null : String(team.managerPersonId),
    managerLabel: team.managerName,
    colour: team.colour,
  };
}

/** Validation rules shared by the create and edit modal (mirrors the server's checks). */
export function teamFormValidation(t: TFunction) {
  return {
    name: nameRule(t, "teams.validation.nameLength", MAX_TEAM_NAME_LENGTH),
    description: descriptionRule(t, "teams.validation.descriptionLength", MAX_TEAM_DESCRIPTION_LENGTH),
  };
}

/**
 * The wire body: a blank description travels as null (the server stores NULL, never ""); a PUT is a
 * full replace, so no manager is an explicit null. The colour travels when there is one (a PUT without it keeps the team's, a POST without it
 * gets the server's least-used key).
 */
export function toTeamBody(values: TeamFormValues): TeamCreateBody & TeamUpdateBody {
  const description = values.description.trim();
  return {
    name: values.name.trim(),
    description: description === "" ? null : description,
    managerPersonId: values.managerPersonId === null ? null : Number(values.managerPersonId),
    ...(values.colour === null ? {} : { colour: values.colour }),
  };
}

/** The team save vocabulary — 409 is about the name field and is handled by the caller. */
export function teamSaveErrorMessage(err: unknown, t: TFunction): string {
  return saveErrorMessage(err, t, {
    forbidden: "teams.saveForbidden",
    notFound: "teams.saveGone",
    invalid: "teams.saveInvalid",
    failedStatus: "common.error.saveFailedStatus",
    failed: "common.error.saveFailedNetwork",
  });
}
