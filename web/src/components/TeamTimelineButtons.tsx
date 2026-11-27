import type { RefObject } from "react";
import { Button, Group } from "@mantine/core";
import { IconRestore, IconWand } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TeamView } from "../api/teams";
import type { useScheduleProposal } from "../hooks/useScheduleProposal";
import { TOOLBAR_CONTROL_SIZE } from "../utils/timelineModel";

type Proposal = ReturnType<typeof useScheduleProposal>;

/**
 * The timeline header's buttons: Propose schedule (only with `team.can.schedule`; disabled while a proposal is open or a write runs,
 * `loading` while it is requested) and Reset order (`team.can.editOrder`, hidden while a proposal is open). Discard lives in the
 * Proposed schedule section.
 */
export default function TeamTimelineButtons({
  view,
  proposal,
  busy,
  proposeRef,
  onReset,
}: {
  view: TeamView;
  proposal: Proposal;
  busy: boolean;
  proposeRef: RefObject<HTMLButtonElement | null>;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const { can } = view.team;
  const open = proposal.proposal;
  return (
    <Group gap="sm" align="center">
      {can.schedule && (
        <Button
          ref={proposeRef}
          variant="default"
          size={TOOLBAR_CONTROL_SIZE}
          leftSection={<IconWand size={14} />}
          loading={proposal.requesting}
          disabled={open !== null || busy}
          onClick={proposal.propose}
        >
          {t("teams.proposal.propose")}
        </Button>
      )}
      {can.editOrder && open === null && (
        <Button variant="default" size={TOOLBAR_CONTROL_SIZE} leftSection={<IconRestore size={14} />} disabled={!view.order.custom || busy} onClick={onReset}>
          {t("teams.view.action.resetOrder")}
        </Button>
      )}
    </Group>
  );
}
