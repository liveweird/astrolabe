import { Button, Group } from "@mantine/core";
import { IconArrowsMaximize, IconArrowsMinimize } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

/**
 * The strip above the plan table: Expand all and Collapse all (the folds themselves are `usePlanFolds`). It is no content, so it does not
 * print. The filters join it later.
 */
export default function PlanToolbar({ onExpandAll, onCollapseAll }: { onExpandAll: () => void; onCollapseAll: () => void }) {
  const { t } = useTranslation();
  return (
    <Group gap="xs" justify="flex-end" data-print="hide">
      <Button variant="default" size="xs" leftSection={<IconArrowsMaximize size={14} />} onClick={onExpandAll}>
        {t("plan.tree.expandAll")}
      </Button>
      <Button variant="default" size="xs" leftSection={<IconArrowsMinimize size={14} />} onClick={onCollapseAll}>
        {t("plan.tree.collapseAll")}
      </Button>
    </Group>
  );
}
