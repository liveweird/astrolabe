import { useId, type RefObject } from "react";
import { Button, Group, Text } from "@mantine/core";
import { IconLink, IconRestore, IconWand } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { TeamView } from "../api/teams";
import type { TeamProposals } from "../hooks/useTeamProposals";
import { MAX_RUN_TEAMS } from "../hooks/useRunTeams";
import { TOOLBAR_CONTROL_SIZE } from "../utils/timelineModel";
import RunTeamsPicker from "./RunTeamsPicker";

/**
 * The timeline header's buttons: Propose schedule (drawn for every viewer, 1.39; disabled while a proposal is open or a write runs,
 * `loading` while it is requested) and Reset order (`team.can.editOrder`, hidden while a proposal is open). Discard lives in the
 * Proposed schedule section. Beside Propose (1.38) the "Plan together with" picker and "Add linked teams" (the teams at the other ends of the links of this team's milestones): with
 * teams chosen Propose runs the cross-team proposal over them and this team, left empty it proposes for this team alone, as it always did, when the viewer may schedule it. A viewer who may not (1.39) gets the same picker and the cross-team run over this team (and the chosen ones) as a preview. The picker is not drawn while a proposal is requested or
 * open (the section names the teams of the run). The wrapped row keeps the buttons reachable at 390 px.
 */
export default function TeamTimelineButtons({
  view,
  proposal,
  busy,
  proposeRef,
  onReset,
}: {
  view: TeamView;
  proposal: TeamProposals;
  busy: boolean;
  proposeRef: RefObject<HTMLButtonElement | null>;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const { can } = view.team;
  const open = proposal.proposal;
  const { linked, addLinked, count, ...picker } = proposal.picker;
  const hintId = useId();
  const hint = proposal.waitingFor === "tooMany" ? t("project.proposal.tooMany", { count, max: MAX_RUN_TEAMS }) : proposal.waitingFor === "rights" ? t("programs.proposal.checking") : null;
  return (
    <Group gap="sm" align="center" wrap="wrap" style={{ minWidth: 0 }}>
      <Button
        ref={proposeRef}
        variant="default"
        size={TOOLBAR_CONTROL_SIZE}
        leftSection={<IconWand size={14} />}
        loading={proposal.requesting}
        disabled={open !== null || busy || !proposal.proposable}
        aria-describedby={hint === null ? undefined : hintId}
        onClick={proposal.propose}
      >
        {t("teams.proposal.propose")}
      </Button>
      {!picker.disabled && (
        <>
          <RunTeamsPicker {...picker} ariaLabel={t("teams.run.pickerLabel")} placeholder={t("teams.run.pickerPlaceholder")} resetLabel={t("teams.run.reset")} />
          {linked.length > 0 && (
            <Button variant="default" size={TOOLBAR_CONTROL_SIZE} leftSection={<IconLink size={14} />} disabled={linked.every((id) => picker.value.includes(id))} onClick={addLinked}>
              {t("teams.run.addLinked")}
            </Button>
          )}
        </>
      )}
      {hint !== null && (
        <Text id={hintId} size="sm" c="dimmed">
          {hint}
        </Text>
      )}
      {can.editOrder && open === null && (
        <Button variant="default" size={TOOLBAR_CONTROL_SIZE} leftSection={<IconRestore size={14} />} disabled={!view.order.custom || busy} onClick={onReset}>
          {t("teams.view.action.resetOrder")}
        </Button>
      )}
    </Group>
  );
}
