import { type ReactNode, type Ref } from "react";
import { Anchor, Group, Stack, Text, Title } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { Link as RouterLink } from "react-router-dom";
import { usePageTitle } from "../hooks/usePageTitle";

/**
 * Every page's first row (v1.19.0): the title (an `order={2}` heading — the name tests and
 * the e2e accessibility scan locate pages by), an optional dimmed description, an optional
 * back link above the title, the page's primary action(s) right-aligned on the SAME row,
 * and an optional toolbar row underneath (the list pages' filter/lens/kind row). One
 * component, so a "New …" button can only ever be in one place. It also names the browser tab
 * after the title (`usePageTitle`): the one owner, so every routed page has a tab title. The title is programmatically focusable
 * (`tabIndex={-1}`, never a tab stop) and `titleRef` hands it out: `useDeleteConfirm` puts the focus there after a row delete.
 */
export default function PageHeader({
  title,
  description,
  backTo,
  actions,
  toolbar,
  titleRef,
}: {
  title: string;
  description?: ReactNode;
  backTo?: { to: string; label: string };
  actions?: ReactNode;
  toolbar?: ReactNode;
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  usePageTitle(title);
  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        <Stack gap={2}>
          {backTo && (
            <Anchor component={RouterLink} to={backTo.to} size="xs" c="dimmed">
              <Group gap={4} wrap="nowrap" component="span">
                <IconArrowLeft size={12} />
                {backTo.label}
              </Group>
            </Anchor>
          )}
          <Title order={2} ref={titleRef} tabIndex={-1}>
            {title}
          </Title>
          {description && (
            <Text c="dimmed" size="sm">
              {description}
            </Text>
          )}
        </Stack>
        {actions && (
          <Group gap="sm" wrap="wrap">
            {actions}
          </Group>
        )}
      </Group>
      {toolbar}
    </Stack>
  );
}
