import type { ReactNode } from "react";
import { DatesProvider } from "@mantine/dates";
import { useTranslation } from "react-i18next";
import "dayjs/locale/pl";
import { asSupportedLanguage } from "../i18n";

/**
 * Hands the UI language to Mantine's date controls (calendar month and weekday names; the value text stays ISO
 * `YYYY-MM-DD` in every language). Each shipped language needs its `dayjs/locale/<lang>` import here — dayjs only knows `en`
 * until a locale file registers itself. Weeks start on Monday, the planning week.
 */
export default function AppDatesProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  return <DatesProvider settings={{ locale: asSupportedLanguage(i18n.resolvedLanguage), firstDayOfWeek: 1 }}>{children}</DatesProvider>;
}
