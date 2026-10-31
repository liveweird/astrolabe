import { useId, useState, type ReactNode } from "react";
import { Box, Button, Stack } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";

/**
 * A long series can run to a thousand rows, so its full table sits behind a disclosure button
 * (`aria-expanded`/`aria-controls`) instead of pushing the page down; the body is not rendered
 * while closed — so a closed table does not print either, and the toggle is on-screen only (`data-print="hide"`).
 * The children are the table itself — scroll and sticky header included; the caller names both button states.
 */
export default function TableDisclosure({
  children,
  showLabel,
  hideLabel,
}: {
  children: ReactNode;
  showLabel: string;
  hideLabel: string;
}) {
  const [open, setOpen] = useState(false);
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
        onClick={() => setOpen((value) => !value)}
      >
        {open ? hideLabel : showLabel}
      </Button>
      <Box id={bodyId} w="100%" hidden={!open}>
        {open && children}
      </Box>
    </Stack>
  );
}
