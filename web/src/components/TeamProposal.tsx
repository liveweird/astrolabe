import { useEffect, useRef, type Ref } from "react";
import { Button, Group, Stack, Text, Title } from "@mantine/core";
import { IconCheck, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { ProposalContent, ScheduleCheckState } from "../utils/scheduleProposal";
import FormErrorAlert from "./FormErrorAlert";
import ProposalTable from "./ProposalTable";

/**
 * The Proposed schedule section of the team page (v0.8): the whole proposal in words and figures beside the dashed bars, and the way to
 * take some or all of it. The table (`ProposalTable`: summary line with the link badges, the moves with a checkbox each, the milestones
 * that could not be placed) between the intro and the actions Accept selected / Discard.
 * Controlled: the page's `useScheduleProposal` owns the selection and the requests; the server decided every date and every link verdict
 * (`proposal` carries the verdicts for the TICKED moves since 1.8, `check` says when they are still the all-moves ones).
 * `busy` disables the accept (another write of the page is running); `applying` is this accept in flight (spinner, nothing else clicks).
 */
export default function TeamProposal({
  proposal,
  selected,
  busy,
  applying,
  onToggle,
  onSelectAll,
  onSelectNone,
  onAccept,
  onDiscard,
  discardRef,
  error,
  check,
}: {
  proposal: ProposalContent;
  selected: ReadonlySet<number>;
  busy: boolean;
  applying: boolean;
  onToggle: (milestoneId: number) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onAccept: () => void;
  onDiscard: () => void;
  discardRef?: Ref<HTMLButtonElement>;
  /** The inline failure of the last accept (already words), or `null`; shown above the actions, and it takes the focus when it appears. */
  error?: string | null;
  /** The state of the ticked-subset check (see `useScheduleCheck`); absent = the verdicts are not subject to a check. */
  check?: Pick<ScheduleCheckState, "pending" | "failed">;
}) {
  const { t } = useTranslation();
  const errorRef = useRef<HTMLDivElement>(null);
  // The accept button was the focus and is disabled while the write runs, so a failure would leave the focus on the body: it goes to the alert.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  return (
    <Stack gap="xs">
      <Title order={3} size="h4">
        {t("teams.proposal.title")}
      </Title>
      <Text size="sm" c="dimmed">
        {t("teams.proposal.intro")}
      </Text>
      <ProposalTable proposal={proposal} selected={selected} applying={applying} onToggle={onToggle} onSelectAll={onSelectAll} onSelectNone={onSelectNone} check={check} />
      {error && (
        <FormErrorAlert ref={errorRef} tabIndex={-1}>
          {error}
        </FormErrorAlert>
      )}
      <Group gap="sm">
        <Button leftSection={<IconCheck size={16} />} loading={applying} disabled={selected.size === 0 || busy} onClick={onAccept}>
          {t("teams.proposal.accept", { count: selected.size })}
        </Button>
        <Button ref={discardRef} variant="default" leftSection={<IconX size={16} />} disabled={applying} onClick={onDiscard}>
          {t("teams.proposal.discard")}
        </Button>
      </Group>
    </Stack>
  );
}
