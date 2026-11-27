import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Group, List, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { getPlanView, planViewKey } from "../api/plan";
import { listEveryTeam } from "../api/teams";
import { ownedBy, type StreamRef } from "../utils/personResponsibilities";
import EntityLink from "./EntityLink";
import ErrorAlert from "./ErrorAlert";
import LoadingBlock from "./LoadingBlock";
import TeamNameCell from "./TeamNameCell";

/** One kind of what a person is responsible for: its h3, how many, and the rows (or the sentence saying there are none). */
function Section({ title, emptyLabel, rows }: { title: string; emptyLabel: string; rows: ReactNode[] }) {
  return (
    <Stack gap={6}>
      <Group gap="xs" align="baseline">
        <Title order={3} size="h4">
          {title}
        </Title>
        <Text size="sm" c="dimmed">
          {rows.length}
        </Text>
      </Group>
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          {emptyLabel}
        </Text>
      ) : (
        // `role="list"`: Safari/VoiceOver drops the semantics of a list whose bullets are removed.
        <List role="list" listStyleType="none" spacing={4} size="sm" aria-label={title}>
          {rows}
        </List>
      )}
    </Stack>
  );
}

/** A row: the node's name as its link, and, dimmed after it, the links to what it sits under (a program's work stream, a project's program and work stream). */
function Row({ entity, parents }: { entity: ReactNode; parents: ReactNode[] }) {
  return (
    <List.Item>
      <Group component="span" gap="xs" wrap="wrap">
        {entity}
        {parents.length > 0 && (
          <Text span size="sm" c="dimmed">
            {parents.map((parent, index) => (
              <Fragment key={index}>
                {index > 0 && " · "}
                {parent}
              </Fragment>
            ))}
          </Text>
        )}
      </Group>
    </List.Item>
  );
}

/**
 * What a person is responsible for on their page (1.37): the teams they manage and the work streams, programs and projects they own, each name a link to its page
 * (`EntityLink`). Read off two reads the plan pages already make: the whole plan view (`planViewKey`, shared with the Plan page and answered by its validator) for the
 * owned nodes, and every team (`["teams","options"]`, shared with the team filters) for the managed ones, so a list is never cut short and "and N more" never arises. A
 * closed work stream reads "(closed)", as everywhere. The two reads fail and load on their own.
 */
export default function PersonResponsibilities({ personId }: { personId: number }) {
  const { t } = useTranslation();
  const plan = useQuery({ queryKey: planViewKey, queryFn: getPlanView });
  const teams = useQuery({ queryKey: ["teams", "options"], queryFn: listEveryTeam });

  const streamName = (stream: StreamRef) => (stream.closed ? t("plan.move.closedName", { name: stream.name }) : stream.name);
  const streamLink = (stream: StreamRef) => <EntityLink entity={{ kind: "workStream", id: stream.id }} name={streamName(stream)} underline="always" />;

  const managed = teams.data?.filter((team) => team.managerPersonId === personId);
  const owned = plan.data === undefined ? undefined : ownedBy(plan.data, personId);

  return (
    <Stack gap="lg">
      {teams.isError && managed === undefined ? (
        <ErrorAlert error={teams.error} title={t("people.responsibilities.teamsFailed")} />
      ) : managed === undefined ? (
        <LoadingBlock />
      ) : (
        <Section
          title={t("people.responsibilities.teams")}
          emptyLabel={t("people.responsibilities.noTeams")}
          rows={managed.map((team) => (
            <List.Item key={team.id}>
              <TeamNameCell name={team.name} colour={team.colour} teamId={team.id} />
            </List.Item>
          ))}
        />
      )}
      {plan.isError && owned === undefined ? (
        <ErrorAlert error={plan.error} title={t("people.responsibilities.ownedFailed")} />
      ) : owned === undefined ? (
        <LoadingBlock />
      ) : (
        <>
          <Section
            title={t("people.responsibilities.workStreams")}
            emptyLabel={t("people.responsibilities.noWorkStreams")}
            rows={owned.workStreams.map((stream) => (
              <Row key={stream.id} parents={[]} entity={<EntityLink entity={{ kind: "workStream", id: stream.id }} name={streamName(stream)} size="sm" />} />
            ))}
          />
          <Section
            title={t("people.responsibilities.programs")}
            emptyLabel={t("people.responsibilities.noPrograms")}
            rows={owned.programs.map((program) => (
              <Row
                key={program.id}
                entity={<EntityLink entity={{ kind: "program", id: program.id }} name={program.name} size="sm" />}
                parents={[streamLink(program.workStream)]}
              />
            ))}
          />
          <Section
            title={t("people.responsibilities.projects")}
            emptyLabel={t("people.responsibilities.noProjects")}
            rows={owned.projects.map((project) => (
              <Row
                key={project.id}
                entity={<EntityLink entity={{ kind: "project", id: project.id }} name={project.name} size="sm" />}
                parents={[<EntityLink entity={{ kind: "program", id: project.program.id }} name={project.program.name} underline="always" />, streamLink(project.workStream)]}
              />
            ))}
          />
        </>
      )}
    </Stack>
  );
}
