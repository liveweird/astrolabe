import type { ReactNode } from "react";
import { Badge } from "@mantine/core";
import { Link as RouterLink } from "react-router-dom";

/**
 * A figure that leads somewhere: a light {@link Badge} rendered as a real `RouterLink` (the idiom of `DeviationCount`, `JiraChips.tsx`). `ariaLabel`
 * tells this link from its siblings where several show the same text on one page (Home's rows); it must contain the visible text.
 */
export default function BadgeLink({ to, color, ariaLabel, children }: { to: string; color: string; ariaLabel?: string; children: ReactNode }) {
  return (
    <Badge color={color} variant="light" tt="none" component={RouterLink} to={to} aria-label={ariaLabel}>
      {children}
    </Badge>
  );
}
