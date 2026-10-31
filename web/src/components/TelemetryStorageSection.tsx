import { useTranslation } from "react-i18next";
import { Stack, Text } from "@mantine/core";
import type { TelemetryCurrent, TelemetryRange } from "../api/telemetry";
import { formatDateTime } from "../utils/formatDate";
import { formatBytes } from "../utils/telemetryFormat";
import { storageColumns } from "../utils/telemetryTrend";
import TelemetryTrend from "./TelemetryTrend";
import TelemetryValueTable from "./TelemetryValueTable";

/** Storage: the database and each schema (measured hourly), and the trend. */
export default function TelemetryStorageSection({ current, range, active }: { current: TelemetryCurrent; range: TelemetryRange; active: boolean }) {
  const { t } = useTranslation();
  const { storage } = current;
  return (
    <Stack gap="md">
      {storage == null ? (
        <Text size="sm" c="dimmed">
          {t("telemetry.storage.notYet")}
        </Text>
      ) : (
        <Stack gap="xs">
          <Text size="xs" c="dimmed">
            {t("telemetry.storage.measuredAt", { time: formatDateTime(storage.measuredAt) })}
          </Text>
          <TelemetryValueTable
            label={t("telemetry.storage.tableAria")}
            rows={[
              { label: t("telemetry.storage.database"), value: formatBytes(storage.databaseBytes) },
              ...storage.schemas.map((schema) => ({ label: t("telemetry.storage.schema", { name: schema.name }), value: formatBytes(schema.bytes) })),
            ]}
          />
        </Stack>
      )}
      <TelemetryTrend group="storage" range={range} columns={storageColumns} label={t("telemetry.section.storage")} active={active} />
    </Stack>
  );
}
