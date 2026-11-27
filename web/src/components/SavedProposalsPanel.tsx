import { useId, useRef } from "react";
import { Stack, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listSavedProposals, savedProposalListKey } from "../api/savedProposals";
import { isBoolean, useStoredState } from "../hooks/useStoredState";
import { ANCHORED_HEADING_STYLE } from "../utils/layout";
import SavedProposalsTable from "./SavedProposalsTable";
import TableDisclosure from "./TableDisclosure";

/** The view-settings key of the show/hide choice (`astrolabe.viewSettings.roadmap.savedProposalsOpen`). */
const OPEN_KEY = "roadmap.savedProposalsOpen";

/**
 * The saved cross-team proposals under the Roadmap overview's timeline (1.33; the list of the former Schedule proposals page): "Saved proposals (N)", the newest 20 runs
 * managers saved for each other to open. Hidden by default and remembered per browser; the count is the list's own, read even while it is hidden (a bounded list, no
 * documents), the table is not rendered while hidden (so it does not print, heading included). A row's name opens that run on the overview above (`?proposal=`), where
 * `useSavedRun` shows it. `openId` (the overview's open saved run, if any) marks its row. Any signed-in user reads; the rows' own `can.delete` carries the right to delete.
 */
export default function SavedProposalsPanel({ openId = null }: { openId?: number | null }) {
  const { t } = useTranslation();
  const list = useQuery({ queryKey: savedProposalListKey, queryFn: listSavedProposals });
  const [open, setOpen] = useStoredState(OPEN_KEY, false, isBoolean);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const count = list.data?.items.length;
  return (
    <Stack component="section" aria-labelledby={headingId} gap="xs">
      <Title id={headingId} order={3} size="h4" ref={headingRef} tabIndex={-1} style={ANCHORED_HEADING_STYLE} data-print={open ? undefined : "hide"}>
        {count === undefined ? t("programs.saved.panelTitle") : t("programs.saved.panelTitleCount", { count })}
      </Title>
      <TableDisclosure open={open} onOpenChange={setOpen} showLabel={t("programs.saved.show")} hideLabel={t("programs.saved.hide")}>
        <SavedProposalsTable list={list} headingRef={headingRef} openId={openId} />
      </TableDisclosure>
    </Stack>
  );
}
