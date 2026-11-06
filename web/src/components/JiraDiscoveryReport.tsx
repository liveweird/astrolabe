import type { TFunction } from "i18next";
import { Alert, List, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconInfoCircle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { JiraDiscoveredField, JiraDiscovery } from "../api/jira";
import { formatDateTime } from "../utils/formatDate";

/** "Target start" (customfield_10015, schema.custom ...): the field as found, with the custom type that identified it kept visible. */
function foundAs(field: JiraDiscoveredField, t: TFunction): string {
  return field.custom
    ? t("jira.report.foundAsCustom", { name: field.name, id: field.id, custom: field.custom })
    : t("jira.report.foundAs", { name: field.name, id: field.id });
}

type Marker = keyof JiraDiscovery["markers"];
type ExpectedMarker = Exclude<Marker, "legacyEpicLink" | "legacyParentLink">;

/** The markers the defaults rest on: each one "not found" is a visible amber line (the first real-site test reads this report). */
const EXPECTED_MARKERS: readonly ExpectedMarker[] = ["targetStart", "targetEnd", "startDate", "dueDate", "storyPoints", "team"];

/** The legacy link fields (A2): informational when present - parent relations may use them instead of the `parent` field; nothing when absent. */
const LEGACY_MARKERS = ["legacyEpicLink", "legacyParentLink"] as const satisfies readonly Marker[];

/**
 * The discovery report: what the stored snapshot holds (counts, the hierarchy levels with their issue types) and one line per assumption
 * marker the mapping defaults rest on - found as which field, or an AMBER "not found" line saying what to do. Read on a real site, it
 * tells whether Plans' "Target start"/"Target end" and the Team field are what the defaults expect before anything is mapped.
 */
export default function JiraDiscoveryReport({ discovery }: { discovery: JiraDiscovery }) {
  const { t } = useTranslation();
  const missing = EXPECTED_MARKERS.filter((marker) => !discovery.markers[marker]);
  const legacy = LEGACY_MARKERS.filter((marker) => discovery.markers[marker]);
  return (
    <Stack gap="xs" role="group" aria-label={t("jira.report.title")}>
      <Text size="sm">
        {t("jira.report.counts", {
          fields: t("jira.report.fieldCount", { count: discovery.fieldCount }),
          types: t("jira.report.typeCount", { count: discovery.issueTypeCount }),
          at: formatDateTime(discovery.discoveredAt),
        })}
      </Text>
      {discovery.fieldsTruncated && (
        <Alert color="orange" variant="light" role="note">
          {t("jira.report.truncated")}
        </Alert>
      )}
      <Text size="sm">
        {discovery.levels.length === 0
          ? t("jira.report.noLevels")
          : t("jira.report.levels", {
              levels: [...discovery.levels]
                .sort((a, b) => b.level - a.level)
                .map((level) => t("jira.mapping.levelOption", { level: level.level, types: level.typeNames.join(", ") }))
                .join("; "),
            })}
      </Text>
      <List spacing={4} size="sm" center aria-label={t("jira.report.markersAria")} style={{ overflowWrap: "anywhere" }}>
        {EXPECTED_MARKERS.flatMap((marker) => {
          const field = discovery.markers[marker];
          return field
            ? [
                <List.Item
                  key={marker}
                  icon={
                    <ThemeIcon color="green" variant="light" size={20} radius="xl" aria-hidden>
                      <IconCheck size={12} />
                    </ThemeIcon>
                  }
                >
                  {t(`jira.report.found.${marker}`, { field: foundAs(field, t) })}
                </List.Item>,
              ]
            : [];
        })}
        {legacy.map((marker) => {
          const field = discovery.markers[marker];
          return field ? (
            <List.Item
              key={marker}
              icon={
                <ThemeIcon color="gray" variant="light" size={20} radius="xl" aria-hidden>
                  <IconInfoCircle size={12} />
                </ThemeIcon>
              }
            >
              {t(`jira.report.found.${marker}`, { field: foundAs(field, t) })}
            </List.Item>
          ) : null;
        })}
      </List>
      {missing.map((marker) => (
        <Alert key={marker} color="orange" variant="light" role="note" icon={<IconAlertTriangle size={16} />} p="xs">
          {t(`jira.report.missing.${marker}`)}
        </Alert>
      ))}
    </Stack>
  );
}
