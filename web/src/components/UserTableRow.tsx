import { Link as RouterLink } from "react-router-dom";
import { Badge, Group, Menu, Table, Text } from "@mantine/core";
import { IconKey, IconPencil, IconShieldCheck, IconToggleLeft, IconTrash, IconUserPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { UserResponse } from "../api/users";
import { editUserPath, userFeaturesPath, userPermissionsPath } from "../utils/userLinks";
import DestructiveMenuItem from "./DestructiveMenuItem";
import EntityLink from "./EntityLink";
import RowActionsMenu from "./RowActionsMenu";

/** One row of the Users table: the name (with the "You" badge on the caller's own row), the email, the role and the row's actions menu. */
export default function UserTableRow({
  user,
  self,
  onCreatePerson,
  onResetPassword,
  onDelete,
}: {
  user: UserResponse;
  /** The caller's own row: no reset (a self-change needs the current password: the Change password page) and no delete (the server 403s it anyway). */
  self: boolean;
  onCreatePerson: () => void;
  onResetPassword: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Table.Tr>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          <EntityLink entity={{ kind: "user", id: user.id }} name={user.name} size="sm" fw={500} />
          {self && <Badge size="xs">{t("users.youBadge")}</Badge>}
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="sm">{user.email}</Text>
      </Table.Td>
      <Table.Td>
        {user.roles.includes("ADMIN") ? (
          <Badge variant="outline" color="gray" size="sm">
            {t("common.role.ADMIN")}
          </Badge>
        ) : (
          <Text size="sm" c="dimmed">
            —
          </Text>
        )}
      </Table.Td>
      <Table.Td style={{ width: 1 }} ta="right">
        <RowActionsMenu label={t("common.table.operationsAria", { name: user.name })}>
          <Menu.Item
            component={RouterLink}
            to={editUserPath(user.id)}
            leftSection={<IconPencil size={14} />}
            aria-label={t("common.action.editAria", { name: user.name })}
          >
            {t("common.action.edit")}
          </Menu.Item>
          <Menu.Item
            component={RouterLink}
            to={userFeaturesPath(user.id)}
            leftSection={<IconToggleLeft size={14} />}
            aria-label={t("users.featuresAria", { name: user.name })}
          >
            {t("users.featuresAction")}
          </Menu.Item>
          <Menu.Item
            component={RouterLink}
            to={userPermissionsPath(user.id)}
            leftSection={<IconShieldCheck size={14} />}
            aria-label={t("users.permissionsAria", { name: user.name })}
          >
            {t("users.permissionsAction")}
          </Menu.Item>
          {user.personId == null && (
            <Menu.Item leftSection={<IconUserPlus size={14} />} onClick={onCreatePerson} aria-label={t("users.createPersonAria", { name: user.name })}>
              {t("users.createPerson")}
            </Menu.Item>
          )}
          {!self && (
            <>
              <Menu.Divider />
              <Menu.Item leftSection={<IconKey size={14} />} onClick={onResetPassword} aria-label={t("users.resetPasswordAria", { name: user.name })}>
                {t("users.resetPassword")}
              </Menu.Item>
              <DestructiveMenuItem leftSection={<IconTrash size={14} />} onClick={onDelete} aria-label={t("common.action.deleteAria", { name: user.name })}>
                {t("common.action.delete")}
              </DestructiveMenuItem>
            </>
          )}
        </RowActionsMenu>
      </Table.Td>
    </Table.Tr>
  );
}
