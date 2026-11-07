import { Text, VisuallyHidden } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { JiraLink } from "../api/roadmap";
import { rollupSentence, rollupText } from "../utils/deviations";

/**
 * A Jira epic's children as compact dimmed text ("5/12 · 34 pt": done of children, then Jira's story points when any child has them), after the
 * Jira key on a milestone's chip and under the Jira item on the Deviations page. The short text is hidden from assistive technology: its accessible
 * name is the full sentence ("12 child issues in Jira, done: 5, story points: 34"), also its tooltip. Nothing for a link without a roll-up. As a flex item
 * it shrinks with an ellipsis (`minWidth: 0`), so in the tray's name cell a long name or key cannot push the row wider.
 */
export default function JiraRollupText({ rollup }: { rollup: JiraLink["rollup"] }) {
  const { t } = useTranslation();
  if (rollup === null) return null;
  const sentence = rollupSentence(rollup, t);
  return (
    <Text size="xs" c="dimmed" component="span" title={sentence} style={{ whiteSpace: "nowrap", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
      <span aria-hidden="true">{rollupText(rollup, t)}</span>
      <VisuallyHidden component="span">{sentence}</VisuallyHidden>
    </Text>
  );
}
