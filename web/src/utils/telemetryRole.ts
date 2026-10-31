import type { TFunction } from "i18next";

/** The process role in words (today only `app`: the API and the sampler share one JVM); an unknown role reads as the server sent it. */
export function roleName(t: TFunction, role: string): string {
  return role === "app" ? t("telemetry.role.app") : role;
}
