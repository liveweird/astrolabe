import { useTranslation } from "react-i18next";
import type { ParseKeys } from "i18next";
import { Badge, Group, Text } from "@mantine/core";
import { formatDateTime } from "../utils/formatDate";

/**
 * The last Test verdict of a connection (Jira or Flow), or - when no test is stored - the "no verdict" text (`untestedKey`: Never tested / tested
 * before the last edit). `layout="fact"` is the facts table's cell (the date, then the badge; the untested text plain); `layout="row"` is the
 * connections list's cell (the badge, then the date, never wrapping; the untested text dimmed). Both use the shared `sync.test.*` verdict words.
 */
export default function ConnectionTestBadge({
  lastTestOk,
  lastTestedAt,
  untestedKey,
  layout,
}: {
  lastTestOk: boolean | null;
  lastTestedAt: number | null;
  untestedKey: ParseKeys;
  layout: "fact" | "row";
}) {
  const { t } = useTranslation();
  if (lastTestedAt === null) {
    return layout === "fact" ? (
      <>{t(untestedKey)}</>
    ) : (
      <Text size="sm" c="dimmed">
        {t(untestedKey)}
      </Text>
    );
  }
  const badge = (
    <Badge color={lastTestOk ? "green" : "red"} variant="light" tt="none">
      {lastTestOk ? t("sync.test.passed") : t("sync.test.notPassed")}
    </Badge>
  );
  const date = <Text size="sm">{formatDateTime(lastTestedAt)}</Text>;
  return layout === "fact" ? (
    <Group gap="xs" wrap="wrap">
      {date}
      {badge}
    </Group>
  ) : (
    <Group gap="xs" wrap="nowrap">
      {badge}
      {date}
    </Group>
  );
}
