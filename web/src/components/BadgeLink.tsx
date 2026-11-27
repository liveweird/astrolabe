import type { ReactNode } from "react";
import { Badge } from "@mantine/core";
import { Link as RouterLink } from "react-router-dom";

/**
 * A figure that leads somewhere: a light {@link Badge} rendered as a real `RouterLink` (the idiom of `DeviationCount`, `JiraChips.tsx`). `ariaLabel`
 * tells this link from its siblings where several show the same text on one page (Home's rows); it must contain the visible text.
 * `whole`: in a table cell the badge keeps its whole text - its label hides overflow, so its minimum width is next to nothing and an auto-layout column
 * would shrink it into an ellipsis.
 */
export default function BadgeLink({
  to,
  color,
  ariaLabel,
  whole = false,
  children,
}: {
  to: string;
  color: string;
  ariaLabel?: string;
  whole?: boolean;
  children: ReactNode;
}) {
  return (
    <Badge color={color} tt="none" miw={whole ? "max-content" : undefined} component={RouterLink} to={to} aria-label={ariaLabel}>
      {children}
    </Badge>
  );
}
