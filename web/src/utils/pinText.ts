import type { TFunction } from "i18next";

/** The ", pinned" suffix of a pinned milestone's bar name (right after the base sentence, before any conflicts or critical suffix). */
export const withPinned = (t: TFunction, describe: string, pinned: boolean) => (pinned ? `${describe}, ${t("timeline.bar.pinned")}` : describe);
