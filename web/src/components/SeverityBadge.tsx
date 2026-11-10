import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge, VisuallyHidden, type MantineSpacing } from "@mantine/core";

/**
 * A deviation or flag severity as a light badge: orange for a warning, gray for an info. The severity is also spelled in a visually hidden word
 * before the text (never colour alone); `hiddenPrefix={false}` for a site whose visible text already is the severity word. `mr` spaces the badge
 * from a sentence that follows it inline. `dimmed` draws it gray whatever the severity (a deviation somebody acknowledged: the word still says
 * Warning/Info, only the loud colour goes).
 */
export default function SeverityBadge({ severity, children, hiddenPrefix = true, mr, dimmed = false }: { severity: "WARNING" | "INFO"; children: ReactNode; hiddenPrefix?: boolean; mr?: MantineSpacing; dimmed?: boolean }) {
  const { t } = useTranslation();
  return (
    <Badge color={severity === "WARNING" && !dimmed ? "orange" : "gray"} variant="light" tt="none" mr={mr}>
      {hiddenPrefix && <VisuallyHidden component="span">{t(`deviations.severity.${severity}`)}: </VisuallyHidden>}
      {children}
    </Badge>
  );
}
