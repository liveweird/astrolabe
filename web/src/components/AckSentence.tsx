import { Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { formatDate, formatDateTime } from "../utils/formatDate";
import { refOf } from "../utils/entityLinks";
import EntityLink from "./EntityLink";
import EntitySentence from "./EntitySentence";

/** A stamp as the Jira line's and the Flow row's acknowledgement carry it: the instant, who (a name only while the login is known, and the person's id when it has one) and whether it still holds. */
export type AckStamp = { at: number; by: string | null; byPersonId: number | null; current: boolean };

/**
 * "Acknowledged by Ada on 2026-11-06" - or, once the figures changed ("current" false), "Acknowledged on 2026-11-06 by Ada · changed since" (the same words for the Jira
 * lines and the Flow sprint rows), the instant in the title. The name is the person's page while the login has an active person (1.31: `byPersonId`), plain
 * text when it has none, and the "unknown" wording of the sentence when the login is gone.
 */
export default function AckSentence({ acknowledgement }: { acknowledgement: AckStamp }) {
  const { t } = useTranslation();
  const { by, byPersonId, current } = acknowledgement;
  const date = formatDate(acknowledgement.at);
  return (
    <Text size="sm" title={formatDateTime(acknowledgement.at)}>
      {by === null ? (
        t(current ? "deviations.ack.doneUnknown" : "deviations.ack.staleUnknown", { date })
      ) : (
        <EntitySentence
          text={(marks) => t(current ? "deviations.ack.done" : "deviations.ack.stale", { name: marks.by, date })}
          slots={{ by: <EntityLink entity={refOf("person", byPersonId)} name={by} /> }}
        />
      )}
    </Text>
  );
}
