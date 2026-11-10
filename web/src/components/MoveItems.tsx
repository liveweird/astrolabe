import { Menu } from "@mantine/core";
import { IconArrowBarDown, IconArrowBarUp, IconArrowDown, IconArrowUp } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

/**
 * The four order moves of a timeline row menu (Move up / down / to top / to bottom), shared by the team page's milestone menu and the roadmap's
 * project menu. `scope` is the i18n prefix that holds the `moveUp`/`moveDown`/`moveTop`/`moveBottom` keys (and their `…Aria`); `first`/`last` disable
 * the moves that cannot go anywhere. The caller binds the row into `onMove`/`onMoveTo` and owns the divider around the block.
 */
export default function MoveItems({
  name,
  scope,
  first,
  last,
  onMove,
  onMoveTo,
}: {
  name: string;
  scope: "teams.view.action" | "roadmap.action";
  first: boolean;
  last: boolean;
  onMove: (delta: -1 | 1) => void;
  onMoveTo: (edge: "top" | "bottom") => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Menu.Item leftSection={<IconArrowUp size={14} />} disabled={first} onClick={() => onMove(-1)} aria-label={t(`${scope}.moveUpAria`, { name })}>
        {t(`${scope}.moveUp`)}
      </Menu.Item>
      <Menu.Item leftSection={<IconArrowDown size={14} />} disabled={last} onClick={() => onMove(1)} aria-label={t(`${scope}.moveDownAria`, { name })}>
        {t(`${scope}.moveDown`)}
      </Menu.Item>
      <Menu.Item leftSection={<IconArrowBarUp size={14} />} disabled={first} onClick={() => onMoveTo("top")} aria-label={t(`${scope}.moveTopAria`, { name })}>
        {t(`${scope}.moveTop`)}
      </Menu.Item>
      <Menu.Item leftSection={<IconArrowBarDown size={14} />} disabled={last} onClick={() => onMoveTo("bottom")} aria-label={t(`${scope}.moveBottomAria`, { name })}>
        {t(`${scope}.moveBottom`)}
      </Menu.Item>
    </>
  );
}
