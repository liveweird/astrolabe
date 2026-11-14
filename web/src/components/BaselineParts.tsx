import type { ComponentProps } from "react";
import { Badge, Button, Group, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { BaselineFigures, MovementTotals } from "../api/baselines";
import EditPageLoadState from "./EditPageLoadState";
import { movementTotalsParts, rowSuffix, type BaselineRow, type movementStatus } from "../utils/baselineOverlay";

// The small pieces the comparison page and the timelines' Movement section share (v0.9): a row's status badge, one side of a comparison, the totals as badges.

const NO_WRAP = { whiteSpace: "nowrap" } as const;

/** A row's status: the ORANGE "Later" when a moved row's end is later (the user's rule), gray otherwise (`movementStatus`). */
export function StatusBadge({ status }: { status: ReturnType<typeof movementStatus> }) {
  const { t } = useTranslation();
  return (
    <Badge color={status.late ? "orange" : "gray"} variant="light" miw="max-content">
      {t(`baselines.status.${status.key}`)}
    </Badge>
  );
}

/** A date range stays on one line: a column of wrapped dates reads as noise (the Start/End headers wrap instead). */
export function DateRange({ start, end }: { start: string; end: string }) {
  return <span style={NO_WRAP}>{`${start} – ${end}`}</span>;
}

/** One side of a comparison: the dates, "Unscheduled" for a milestone with none, "—" for a side that does not exist. */
export function Figures({ figures }: { figures: BaselineFigures | null }) {
  const { t } = useTranslation();
  if (figures === null) return <>—</>;
  return figures.start === null || figures.end === null ? <>{t("baselines.compare.unscheduled")}</> : <DateRange start={figures.start} end={figures.end} />;
}

/**
 * The totals as badges (ORANGE for the rows whose end is later), or the "no schedule changes" line; `label` leads the line. `estimateOnly` (the
 * Movement section's) adds a gray "N re-estimated" badge - a re-estimated row is not a schedule change but the table lists it, so the line never
 * says "No schedule changes" above it.
 */
export function TotalsBadges({
  label,
  totals,
  role,
  estimateOnly = 0,
  extra = [],
}: {
  label?: string;
  totals: MovementTotals;
  role?: "note";
  estimateOnly?: number;
  /** More gray badges after the movement ones (the roadmap's rank movement), in the same group. */
  extra?: readonly { key: string; label: string }[];
}) {
  const { t } = useTranslation();
  const parts = movementTotalsParts(totals, t);
  return (
    <Group gap="xs" wrap="wrap" role={role}>
      {label !== undefined && (
        <Text size="sm" fw={500} component="span">
          {label}
        </Text>
      )}
      {parts.length === 0 && estimateOnly === 0 ? (
        <Text size="sm" c="dimmed" component="span">
          {t("baselines.totals.none")}
        </Text>
      ) : (
        <>
          {parts.map((part) => (
            <Badge key={part.key} color={part.late ? "orange" : "gray"} variant="light">
              {part.label}
            </Badge>
          ))}
          {estimateOnly > 0 && (
            <Badge color="gray" variant="light">
              {t("baselines.totals.estimateOnly", { count: estimateOnly })}
            </Badge>
          )}
        </>
      )}
      {extra.map((part) => (
        <Badge key={part.key} color="gray" variant="light">
          {part.label}
        </Badge>
      ))}
    </Group>
  );
}

/** The name cell of a row appended after the current ones: dimmed, with a parenthesised mark after the name (the one place that renders "name (mark)"). */
export function AppendedRowName({ name, mark }: { name: string; mark: string }) {
  return (
    <Text component="span" size="sm" c="dimmed" truncate>
      {name} {mark}
    </Text>
  );
}

/** The name cell of a row the overlay appends: dimmed, with what became of the milestone after it ("(removed)", "(unscheduled since the baseline)", "(moved to X)"). */
export function BaselineRowName({ row }: { row: Pick<BaselineRow, "name" | "reason" | "movedTo"> }) {
  const { t } = useTranslation();
  return <AppendedRowName name={row.name} mark={rowSuffix(row, t)} />;
}

/**
 * The way out of a pick whose view cannot be loaded (a server failure that is not the typed "unknown baseline": that one clears itself): the page
 * has no timeline then - so no picker - and the pick would otherwise stay stuck.
 */
export function ShowWithoutBaseline({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Group justify="flex-end">
      <Button variant="default" onClick={onClick}>
        {t("timeline.baseline.showWithout")}
      </Button>
    </Group>
  );
}

/**
 * The detail pages' (project, team) load triage, plus the way out of a stuck pick: while the view cannot be loaded WITH a baseline picked
 * (and it is not the typed "unknown baseline", which clears itself, nor a not-found), the page shows "Show without a baseline" under the failure.
 */
export function PickedLoadState({
  pick,
  isError,
  dropping,
  notFound,
  onClearPick,
  ...state
}: ComponentProps<typeof EditPageLoadState> & { pick: number | null; isError: boolean; dropping: boolean; notFound: boolean; onClearPick: () => void }) {
  return (
    <Stack gap="md">
      <EditPageLoadState {...state} isLoading={state.isLoading || dropping} />
      {pick !== null && isError && !dropping && !notFound && <ShowWithoutBaseline onClick={onClearPick} />}
    </Stack>
  );
}
