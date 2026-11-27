import { Button, Group, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

/**
 * The note over a saved run's table (1.33; nothing when `count` is 0): `count` of the projects it moves are outside the current program pick, so the timeline above has no bar for them (the table lists
 * every one). `onShowAll` clears the pick (`null` when none is set: the hidden ones are then a work stream narrowing's, which has its own control).
 */
export default function OutsidePickNote({ count, onShowAll }: { count: number; onShowAll: (() => void) | null }) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return (
    <Group gap="xs" role="note" data-print="hide">
      <Text size="sm">{t("programs.saved.outside", { count })}</Text>
      {onShowAll !== null && (
        <Button variant="subtle" size="compact-sm" onClick={onShowAll}>
          {t("programs.saved.showAll")}
        </Button>
      )}
    </Group>
  );
}
