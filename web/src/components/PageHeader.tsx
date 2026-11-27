import { type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { ActionIcon, Anchor, Box, Group, Popover, Stack, Text, Title } from "@mantine/core";
import { IconArrowLeft, IconInfoCircle } from "@tabler/icons-react";
import { Link as RouterLink } from "react-router-dom";
import { usePageTitle } from "../hooks/usePageTitle";
import classes from "../theme.module.css";

/**
 * Every page's first row (v1.19.0): the title (an `order={2}` heading — the name tests and the e2e accessibility scan locate pages by), an optional back link above it,
 * the page's primary action(s) right-aligned on the SAME row as the title, and, underneath, the full-width `facts` line, the optional `toolbar` row (the list pages'
 * filter/lens/kind row). One component, so a "New …" button can only ever be in one place. It also names the browser tab after the title (`usePageTitle`): the one
 * owner, so every routed page has a tab title. The title is programmatically focusable (`tabIndex={-1}`, never a tab stop) and `titleRef` hands it out:
 * `useDeleteConfirm` puts the focus there after a row delete. `titleLead` (1.29: the team page's colour swatch) sits before the title and `titleAddon` (1.9: the team
 * page's Flow capacity flag) after the info button. `switcher` (1.29: the project page's picker) is a control above the title, where a back link would be (a page with
 * one keeps its link beneath it); it is no content, so it does not print.
 *
 * `facts` (a visible, compact dimmed line: an entity page's linked program/owner/manager line, a person's email and login, a read-only status) is the page's data,
 * never hidden. The `description` (free text: a page's generic intro, an entity's written description) is never on the page itself: it sits behind a small info button
 * named "About this page: {title}" right after the title (a non-modal popover: a dialog named by the button, focus moves in on open and back to the button on Escape,
 * an outside click closes it, links inside stay usable). The button and the popover do not print; with `printDescription` (an entity's own written text) a
 * `data-print="only"` copy sits under the title, so it still reaches the paper, while a generic intro (the default) stays out.
 */
export default function PageHeader({
  title,
  description,
  printDescription,
  facts,
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
  /** The description is the entity's own written text: it also prints, as a print-only copy under the title. */
  printDescription?: boolean;
  facts?: ReactNode;
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
    <Stack gap="xs" className={classes.pageHeader}>
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
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
          <Group gap="xs" align="center" wrap="wrap" mih={actions ? 36 : undefined}>
            <Group gap={4} align="center" wrap="nowrap" maw="100%" miw={0}>
              {titleLead}
              <Title order={2} ref={titleRef} tabIndex={-1} className={classes.pageHeading}>
                {title}
              </Title>
              {description && <PageDescription title={title}>{description}</PageDescription>}
            </Group>
            {titleAddon}
          </Group>
        </Stack>
        {actions && (
          <Group gap="sm" wrap="wrap">
            {actions}
          </Group>
        )}
      </Group>
      {facts && (
        <Text c="dimmed" size="sm" component="div" className={classes.pageFacts}>
          {facts}
        </Text>
      )}
      {description && printDescription && (
        <Text c="dimmed" size="sm" component="div" data-print="only" className={classes.pageFacts}>
          {description}
        </Text>
      )}
      {toolbar}
    </Stack>
  );
}

/** The description behind its "About this page: {title}" button: Mantine's Popover supplies `aria-haspopup`, `aria-expanded`, `aria-controls` (while open) and the dropdown's dialog role named by the button. */
function PageDescription({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Popover width={440} position="bottom-start" shadow="md" trapFocus returnFocus>
      <Popover.Target>
        <ActionIcon size={24} aria-label={t("common.action.aboutPage", { title })} data-print="hide">
          <IconInfoCircle size={16} aria-hidden="true" />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown maw="calc(100vw - 2rem)" p="sm">
        <Text size="sm" component="div" className={classes.pageDescription}>
          {children}
        </Text>
      </Popover.Dropdown>
    </Popover>
  );
}
