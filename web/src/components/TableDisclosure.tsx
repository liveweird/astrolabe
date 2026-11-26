import { useId, useState, type ReactNode } from "react";
import { Box, Button, Stack } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";

/**
 * A long series can run to a thousand rows, so its full table sits behind a disclosure button
 * (`aria-expanded`/`aria-controls`) instead of pushing the page down; the body is not rendered
 * while closed — so a closed table does not print either, and the toggle is on-screen only (`data-print="hide"`).
 * The children are the table itself — scroll and sticky header included; the caller names both button states.
 * Uncontrolled and closed by default; with `open` and `onOpenChange` the caller owns the state (a remembered choice: the project page's Milestones table).
 */
export default function TableDisclosure({
  children,
  showLabel,
  hideLabel,
  open: controlledOpen,
  onOpenChange,
}: {
  children: ReactNode;
  showLabel: string;
  hideLabel: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  const bodyId = useId();
  return (
    <Stack gap="xs" align="flex-start">
      <Button
        variant="subtle"
        size="compact-sm"
        data-print="hide"
        leftSection={open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        {open ? hideLabel : showLabel}
      </Button>
      <Box id={bodyId} w="100%" hidden={!open}>
        {open && children}
      </Box>
    </Stack>
  );
}
