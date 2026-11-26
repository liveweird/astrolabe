import { type ReactNode, type Ref } from "react";
import { Anchor, Box, Group, Stack, Text, Title } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { Link as RouterLink } from "react-router-dom";
import { usePageTitle } from "../hooks/usePageTitle";
import classes from "../theme.module.css";

/**
 * Every page's first row (v1.19.0): the title (an `order={2}` heading — the name tests and
 * the e2e accessibility scan locate pages by), an optional dimmed description, an optional
 * back link above the title, the page's primary action(s) right-aligned on the SAME row,
 * and an optional toolbar row underneath (the list pages' filter/lens/kind row). One
 * component, so a "New …" button can only ever be in one place. It also names the browser tab
 * after the title (`usePageTitle`): the one owner, so every routed page has a tab title. The title is programmatically focusable
 * (`tabIndex={-1}`, never a tab stop) and `titleRef` hands it out: `useDeleteConfirm` puts the focus there after a row delete. `titleAddon` (1.9: the
 * team page's Flow capacity flag) sits beside the title on its row; `titleLead` (1.29: the team page's colour swatch) sits before it; without either the title is rendered exactly as before. `switcher` (1.29: the project page's picker) is a
 * control above the title, where a back link would be (a page with one keeps its link beneath it); it is no content, so it does not print.
 */
export default function PageHeader({
  title,
  description,
  backTo,
  actions,
  toolbar,
  titleRef,
  titleAddon,
  titleLead,
  switcher,
}: {
  title: string;
  description?: ReactNode;
  backTo?: { to: string; label: string };
  actions?: ReactNode;
  toolbar?: ReactNode;
  titleRef?: Ref<HTMLHeadingElement>;
  titleAddon?: ReactNode;
  titleLead?: ReactNode;
  switcher?: ReactNode;
}) {
  usePageTitle(title);
  return (
    <Stack gap="sm" className={classes.pageHeader}>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        <Stack gap={2}>
          {switcher && (
            <Box data-print="hide" mb={6}>
              {switcher}
            </Box>
          )}
          {backTo && (
            <Anchor component={RouterLink} to={backTo.to} size="xs" c="dimmed">
              <Group gap={4} wrap="nowrap" component="span">
                <IconArrowLeft size={12} />
                {backTo.label}
              </Group>
            </Anchor>
          )}
          {titleAddon || titleLead ? (
            <Group gap="xs" align="center" wrap="wrap">
              {titleLead}
              <Title order={2} ref={titleRef} tabIndex={-1} className={classes.pageHeading}>
                {title}
              </Title>
              {titleAddon}
            </Group>
          ) : (
            <Title order={2} ref={titleRef} tabIndex={-1} className={classes.pageHeading}>
              {title}
            </Title>
          )}
          {description && (
            <Text c="dimmed" size="sm" className={classes.pageDescription}>
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
