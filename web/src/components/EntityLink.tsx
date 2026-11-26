import type { MouseEventHandler, ReactNode } from "react";
import { Anchor, Text, type TextProps } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { useAdmin } from "../auth";
import { entityPath, type EntityRef } from "../utils/entityLinks";
import type { RovingTarget } from "../utils/timelineModel";

/**
 * In a timeline's roving grid a name is the cell's `stop` (the roving attributes, spread on the link - or on the text when the name is not a link), or `secondary`: a second
 * name in a cell whose one stop is another element, the pointer's link, out of the tab order (the row menu carries the keyboard's "Open ..." item). Never both.
 */
type GridPlacement = { stop?: RovingTarget; secondary?: false } | { stop?: never; secondary: true };

export type EntityLinkProps = Omit<TextProps, "children"> & GridPlacement & {
  /** What the name stands for; `null` when its id is unknown (the name is then plain text, never a guessed link). */
  entity: EntityRef | null;
  /** The entity's name: the visible text unless `children` is given, and the `{{name}}` of the accessible name. */
  name: string;
  /** What to show instead of the bare name (a team's colour swatch with its name, a sentence part). */
  children?: ReactNode;
  /** The entity is this page's own subject (its header, a marked row): the same typography as plain text, no link. */
  current?: boolean;
  /** A destination other than the entity's own page (the link still names the entity). */
  to?: string;
  /** An accessible name other than the entity's `common.entity.open.<kind>`; it must start with the visible text. */
  "aria-label"?: string;
  title?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
};

/**
 * An entity's NAME as the way into its page (1.31): a real link in the theme's own Anchor look (text colour, underline on hover), its accessible name
 * `common.entity.open.<kind>` ("Open project {{name}}"). The ONE component for a work stream, program, project, milestone, team, person or login name:
 * no page hand-assembles an entity's address (`entityLinkGuard.test.ts`). A null `entity`, or `current`, shows the name as plain text of the same typography;
 * a `user` is a link for an ADMIN only (the edit page is theirs). "Where not to link": web-internals "Entity links".
 */
export default function EntityLink({ entity, name, children, stop, secondary, current, to, "aria-label": ariaLabel, title, onClick, ...typography }: EntityLinkProps) {
  const { t } = useTranslation();
  const admin = useAdmin();
  const content = children ?? name;
  if (entity === null || current === true || (entity.kind === "user" && !admin)) {
    return (
      // The cell's roving stop stays on the text when the name stops being a link (`current`, a null entity), so the grid keeps its position.
      <Text span title={title} {...typography} {...stop}>
        {content}
      </Text>
    );
  }
  return (
    <Anchor
      component={RouterLink}
      to={to ?? entityPath(entity)}
      aria-label={ariaLabel ?? t(`common.entity.open.${entity.kind}`, { name })}
      title={title}
      onClick={onClick}
      {...typography}
      {...(secondary === true ? { tabIndex: -1 } : stop)}
    >
      {content}
    </Anchor>
  );
}
