import type { ReactNode } from "react";
import { Anchor, Group, Stack, Switch, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import type { HomeMe, HomeView } from "../api/home";
import { useAdmin } from "../auth";
import { isBoolean, useStoredState } from "../hooks/useStoredState";
import { peoplePath } from "../utils/peopleLinks";
import { roadmapFilteredPath, roadmapOverviewPath } from "../utils/planLinks";
import { isStaleSource } from "../utils/staleness";
import HomeNodesTable from "./HomeNodesTable";
import HomeProjectsTable from "./HomeProjectsTable";
import HomeTeamsTable from "./HomeTeamsTable";
import { JiraStaleNote } from "./JiraChips";
import LoadingBlock from "./LoadingBlock";

/** The cap the spec states for each of the four lists (`MAX_HOME_ROWS` on the server); `truncated` says one was cut. */
const MAX_HOME_ROWS = 100;

/** The switch's remembered state (`astrolabe.viewSettings.home.mine.ownOnly`); `useStoredState` wraps every localStorage read and write in try/catch. */
const OWN_ONLY_KEY = "home.mine.ownOnly";

/** The switch narrows the projects and programs tables, so it is offered only while one of them has a row. */
const hasOwnOnlySwitch = (me: HomeMe) => me.projects.length + me.programs.length > 0;

/** One table's h4 above it; each table is shown only when it has a row. */
function TableBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack gap="xs">
      <Title order={4} size="h5">
        {title}
      </Title>
      {children}
    </Stack>
  );
}

/**
 * The person's own tables; the caller has checked that at least one list has a row. With `ownOnly` the projects and programs shrink to the rows that are
 * the person's own (`direct`; a work stream is listed only when they own it) - on the client, from the document's own rows. A list the switch empties
 * keeps its heading and says so about the LISTED rows only: the document may have cut the list (`truncated`), so it never claims the person owns none.
 */
function MineTables({ me, ownOnly, onOwnOnlyChange }: { me: HomeMe; ownOnly: boolean; onOwnOnlyChange: (next: boolean) => void }) {
  const { t } = useTranslation();
  const projects = ownOnly ? me.projects.filter((project) => project.direct) : me.projects;
  const programs = ownOnly ? me.programs.filter((program) => program.direct) : me.programs;
  const nodes = me.workStreams.length + me.programs.length > 0;
  return (
    <>
      {hasOwnOnlySwitch(me) && (
        <Switch label={t("home.mine.ownOnly")} checked={ownOnly} onChange={(event) => onOwnOnlyChange(event.currentTarget.checked)} />
      )}
      {me.projects.length > 0 && (
        <TableBlock title={t("home.mine.projects")}>
          {projects.length > 0 ? <HomeProjectsTable projects={projects} /> : <Text size="sm">{t("home.mine.ownOnlyNoProjects")}</Text>}
          {/* The Roadmap's Owner filter is direct ownership, so the link is offered only beside a project the person owns themselves. */}
          {projects.some((project) => project.direct) && (
            <Anchor component={RouterLink} to={roadmapFilteredPath({ filters: { ownerPersonId: me.personId } })} size="sm" fw={500}>
              {t("home.mine.onRoadmap")}
            </Anchor>
          )}
        </TableBlock>
      )}
      {me.teams.length > 0 && (
        <TableBlock title={t("home.mine.teams")}>
          <HomeTeamsTable teams={me.teams} />
        </TableBlock>
      )}
      {nodes && (
        <TableBlock title={t("home.mine.nodes")}>
          {me.workStreams.length + programs.length > 0 ? (
            <HomeNodesTable workStreams={me.workStreams} programs={programs} personName={me.name} />
          ) : (
            <Text size="sm">{t("home.mine.ownOnlyNoPrograms")}</Text>
          )}
          <Anchor component={RouterLink} to={roadmapOverviewPath} size="sm" fw={500}>
            {t("home.mine.openOverview")}
          </Anchor>
        </TableBlock>
      )}
    </>
  );
}

/** The body for a read that has answered: the sentence for a login without a person, the person's line with its tables, or the "owns nothing" sentence. */
function MineBody({ view, flowStale }: { view: HomeView; flowStale: boolean }) {
  const { t } = useTranslation();
  const admin = useAdmin();
  const [ownOnly, setOwnOnly] = useStoredState(OWN_ONLY_KEY, false, isBoolean);
  const { me } = view;
  if (me === null) {
    return (
      <>
        <Text size="sm">{t("home.mine.noPerson")}</Text>
        {/* UX only: the People page is readable by everyone and the server gates its writes; the administrator is who can link a login to a person. */}
        {admin && (
          <Anchor component={RouterLink} to={peoplePath} size="sm" fw={500}>
            {t("home.mine.openPeople")}
          </Anchor>
        )}
      </>
    );
  }
  const rows = me.workStreams.length + me.programs.length + me.projects.length + me.teams.length > 0;
  const narrowed = ownOnly && hasOwnOnlySwitch(me);
  // The staleness sentences follow the pages the figures link to: Jira's is the plan pages' plan-wide fold, Flow's shows when a listed team carries a Flow flag.
  const jiraStale = rows && view.jiraSites.some(isStaleSource);
  const flowNote = rows && flowStale && me.teams.some((team) => team.flags.some((flag) => flag.kind === "FLOW_CAPACITY"));
  return (
    <>
      <Group gap="md" wrap="wrap">
        <Text size="sm" c="dimmed">
          {t("home.mine.person", { name: me.name })}
        </Text>
        {jiraStale && <JiraStaleNote />}
        {flowNote && (
          <Text size="sm" c="dimmed">
            {t("home.deviations.flowStale")}
          </Text>
        )}
      </Group>
      {rows && (
        <Text size="sm" c="dimmed">
          {t(narrowed ? "home.mine.scopeOwn" : "home.mine.scope")}
        </Text>
      )}
      {rows ? <MineTables me={me} ownOnly={narrowed} onOwnOnlyChange={setOwnOnly} /> : <Text size="sm">{t("home.mine.nothing", { name: me.name })}</Text>}
      {me.truncated && (
        <Text size="sm" c="dimmed">
          {t("home.mine.truncated", { count: MAX_HOME_ROWS })}
        </Text>
      )}
    </>
  );
}

/**
 * "Yours" (1.18): a section under the cards, never a fourth card. What the signed-in login's linked person may manage through the owner chain (what they
 * own and everything under a work stream or program they own, each program and project row naming its owner) and the teams that person manages, from
 * `GET /views/home`'s `me` - the document, never the session's role, says who that is. A switch ("Only what I own myself", off by default, remembered in
 * this browser) narrows the projects and programs to the rows that are the person's own. `view` is undefined while the first read is pending
 * (the heading and the spinner); the caller mounts nothing at all for a failed first read.
 */
export default function HomeMine({ view, flowStale }: { view: HomeView | undefined; flowStale: boolean }) {
  const { t } = useTranslation();
  return (
    <Stack gap="sm">
      <Title order={3} size="h4">
        {t("home.mine.title")}
      </Title>
      {view === undefined ? <LoadingBlock /> : <MineBody view={view} flowStale={flowStale} />}
    </Stack>
  );
}
