import { Alert, Button, Group, Text, VisuallyHidden } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useLiveText } from "../hooks/useLiveText";

/**
 * What narrows the Roadmap overview, said in words above the timeline (1.31): the work stream the page is narrowed to - the node a work stream's name leads to - with
 * its way back, the notice for a work stream the plan no longer has, and, when the narrowing leaves no project at all (a work stream or program with none yet), a line saying
 * so beside the way back instead of a bare row. The program pick keeps its own field in the filter panel; here it only matters for that empty line.
 * The two sentences are also said through ONE always-mounted polite status region, filled after the render (`useLiveText`), and the visible ones are plain
 * (a `note` Alert, a Text): a status region inserted with its text is not reliably announced, and an Alert's implicit `role="alert"` would read it twice.
 */
export default function ProgramsNarrowing({
  workStreamName,
  pickCount,
  empty,
  unknown,
  onClearWorkStream,
  onClearPick,
  onDismissUnknown,
}: {
  /** The work stream the overview is narrowed to, or `null`. */
  workStreamName: string | null;
  /** How many programs are picked (0 = all). */
  pickCount: number;
  /** The narrowing leaves no project. */
  empty: boolean;
  /** The address named a work stream the plan does not have: it was dropped. */
  unknown: boolean;
  onClearWorkStream: () => void;
  onClearPick: () => void;
  onDismissUnknown: () => void;
}) {
  const { t } = useTranslation();
  const narrowedEmpty = empty && (workStreamName !== null || pickCount > 0);
  const emptyText = workStreamName === null ? t("programs.narrow.noProjectsPicked", { count: pickCount }) : t("programs.narrow.noProjectsStream");
  const said = useLiveText([unknown ? t("programs.narrow.unknown") : "", narrowedEmpty ? emptyText : ""].filter(Boolean).join(" "));
  return (
    <>
      <VisuallyHidden role="status" aria-live="polite">
        {said}
      </VisuallyHidden>
      {unknown && (
        <Alert color="orange" variant="light" role="note" withCloseButton closeButtonLabel={t("common.action.dismissNotice")} onClose={onDismissUnknown}>
          {t("programs.narrow.unknown")}
        </Alert>
      )}
      {workStreamName !== null && (
        <Group gap="sm" data-print="hide">
          <Text size="sm" fw={500}>
            {t("programs.narrow.workStream", { name: workStreamName })}
          </Text>
          <Button variant="default" size="compact-sm" onClick={onClearWorkStream}>
            {t("programs.narrow.showStreams")}
          </Button>
        </Group>
      )}
      {narrowedEmpty && (
        <Group gap="sm">
          <Text c="dimmed">{emptyText}</Text>
          {workStreamName === null && (
            <Button variant="default" size="compact-sm" onClick={onClearPick} data-print="hide">
              {t("programs.narrow.showPrograms")}
            </Button>
          )}
        </Group>
      )}
    </>
  );
}
