import { Menu } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { entityPath, type EntityRef } from "../utils/entityLinks";

/**
 * A row menu's "Open <kind> <name>" item (1.31): the keyboard's way to a second name of a Timeline cell, whose pointer link is out of the tab order
 * (`EntityLink secondary`; the cell's one stop is another element). Worded and named like the link itself (`common.entity.open.<kind>`).
 */
export default function OpenEntityItem({ entity, name }: { entity: EntityRef; name: string }) {
  const { t } = useTranslation();
  const label = t(`common.entity.open.${entity.kind}`, { name });
  return (
    <Menu.Item component={RouterLink} to={entityPath(entity)} leftSection={<IconExternalLink size={14} />} aria-label={label}>
      {label}
    </Menu.Item>
  );
}
