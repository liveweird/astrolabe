import { useTranslation } from "react-i18next";
import { useDocumentTitle } from "@mantine/hooks";

/**
 * Names the browser tab after the page ("Teams · Astrolabe"), in the UI language. The ONE owner is `PageHeader`
 * (and `AuthCard` for the pages outside the shell). The brand alone, or a blank name (an entity title that has
 * not arrived), is just "Astrolabe" — never " · Astrolabe". `useDocumentTitle` does not restore the previous
 * title on unmount: the next page sets its own, and `index.html` holds the first-paint fallback.
 */
export function usePageTitle(page: string): void {
  const { t } = useTranslation();
  const name = page.trim();
  const brand = t("appShell.brand");
  useDocumentTitle(name === "" || name === brand ? brand : t("appShell.documentTitle", { page: name }));
}
