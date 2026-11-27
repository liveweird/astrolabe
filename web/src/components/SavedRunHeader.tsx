import { Fragment } from "react";
import { Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { SavedProposalRecord } from "../api/savedProposals";
import { refOf } from "../utils/entityLinks";
import { formatDateTime } from "../utils/formatDate";
import EntityLink from "./EntityLink";
import EntitySentence from "./EntitySentence";
import SavedProposalState from "./SavedProposalState";

/**
 * What the Roadmap overview says of a SAVED proposal's run (1.33): who saved it and when, the day it was computed for, its teams (links while the plan still matches: a team of a
 * `CHANGED` run may be gone), how many moves were ticked and the plan revision, then the state badge with its words. The server's own record, shown as it is.
 */
export default function SavedRunHeader({ record, fresh, outdated, editable }: { record: SavedProposalRecord; fresh: boolean; outdated: boolean; editable: boolean }) {
  const { t } = useTranslation();
  const by = record.createdBy;
  const planMatches = record.state === "CURRENT";
  const teams = record.teams.map((team, index) => (
    <Fragment key={team.id}>
      {index > 0 && ", "}
      <EntityLink entity={{ kind: "team", id: team.id }} name={team.name} current={!planMatches} />
    </Fragment>
  ));
  return (
    <>
      <Text size="sm">
        <EntitySentence
          text={(marks) =>
            t(by === null ? "scheduleProposals.saved.factsAnonymous" : "scheduleProposals.saved.facts", {
              name: marks.by,
              when: formatDateTime(record.createdAt),
              asOf: record.asOf,
              teams: marks.teams,
              selected: record.selectedCount,
              total: record.moveCount,
              revision: record.planRevision,
            })
          }
          slots={{ by: by === null ? "" : <EntityLink entity={refOf("person", by.personId)} name={by.name} />, teams }}
        />
      </Text>
      <SavedProposalState record={record} fresh={fresh} outdated={outdated} editable={editable} />
    </>
  );
}
