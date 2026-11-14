// Shared fixtures for the Home page: whole documents as GET /views/home answers them.
import type { HomeMe, HomeView } from "../api/home";

/** A person's block with nothing owned or managed (the C6 "Yours" section reads it; C5 ignores it). */
export function homeMe(over: Partial<HomeMe> = {}): HomeMe {
  return { personId: 12, name: "Alex Example", workStreams: [], programs: [], projects: [], teams: [], truncated: false, ...over };
}

/** The document of a login without a person: the plan's figures, `me: null`, no Jira site. Override any member (`plan` is replaced whole). */
export function homeView(over: Partial<HomeView> = {}): HomeView {
  return {
    revision: 4711,
    plan: {
      workStreams: 5,
      programs: 20,
      projects: 100,
      rankedProjects: 80,
      unrankedProjects: 20,
      milestones: 1000,
      unscheduledMilestones: 100,
      flags: { warnings: 208, infos: 52 },
      conflicts: 9,
      overloadedTeams: 3,
      wipExceededTeams: 1,
    },
    me: null,
    jiraSites: [],
    ...over,
  };
}

/** An empty plan: every figure zero, no person, no Jira site (what a fresh stack answers). */
export function emptyHomeView(): HomeView {
  const { plan } = homeView();
  const zeros = Object.fromEntries(Object.keys(plan).map((key) => [key, 0])) as unknown as HomeView["plan"];
  return homeView({ plan: { ...zeros, flags: { warnings: 0, infos: 0 } } });
}
