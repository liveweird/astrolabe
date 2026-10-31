import { Link as RouterLink } from "react-router-dom";
import { Anchor, Group, Switch, Table, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { Feature } from "../api/session";
import { userFeaturesPath } from "../utils/userLinks";
import { isFeatureEnabled, type UserRow } from "../utils/featureFlags";

/**
 * One /feature-flags row: the name opens the user's per-user features editor (the screen
 * otherwise gives no way into it), then the email and the feature's enabled switch.
 */
export default function FeatureFlagRow({
  user,
  feature,
  featureLabel,
  pending,
  onToggle,
}: {
  user: UserRow;
  feature: Feature;
  featureLabel: string;
  pending: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Table.Tr>
      <Table.Td>
        <Anchor
          component={RouterLink}
          to={userFeaturesPath(user.id)}
          size="sm"
          fw={500}
          aria-label={t("users.featuresAria", { name: user.name })}
        >
          {user.name}
        </Anchor>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{user.email}</Text>
      </Table.Td>
      <Table.Td>
        <Group justify="center">
          <Switch
            checked={isFeatureEnabled(user.disabledFeatures, feature)}
            disabled={pending}
            onChange={onToggle}
            aria-label={t("users.featureFlags.toggleAria", {
              feature: featureLabel,
              name: user.name,
            })}
          />
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}
