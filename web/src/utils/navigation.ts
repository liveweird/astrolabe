import type { ParseKeys } from "i18next";
import { IconActivity, IconAddressBook, IconCalendarOff, IconCamera, IconGitCompare, IconHistory, IconHome2, IconKey, IconListNumbers, IconListTree, IconPlugConnected, IconSitemap, IconToggleLeft, IconUsers, IconUsersGroup, type Icon } from "@tabler/icons-react";
import { baselinesPath } from "./baselineLinks";
import { deviationsPath } from "./deviationLinks";
import { publicHolidaysPath } from "./calendarLinks";
import { flowConnectionsPath } from "./flowLinks";
import { jiraConnectionsPath } from "./jiraLinks";
import { peoplePath } from "./peopleLinks";
import { planPath, programsPath, roadmapPath } from "./planLinks";
import { teamsPath } from "./teamLinks";
import { usersPath } from "./userLinks";

export type NavLeaf = {
  to: string;
  /** An i18n key, resolved with t() at render time. */
  label: ParseKeys;
  icon: Icon;
  /** When set, the leaf renders only for ADMIN sessions. */
  adminOnly?: boolean;
  /**
   * Further routes this leaf stays highlighted on (a report group's other tabs, each of which
   * is its own route). Prefix-matched like `to`; the leaf itself always links to `to`.
   */
  activeFor?: ReadonlyArray<string>;
  /** Extra palette search terms (raw, language-neutral) — a page renamed since people learned its old name. */
  keywords?: ReadonlyArray<string>;
};

/** A labelled, always-open block of leaves — a section, never a collapsible group. */
export type NavSection = {
  label: ParseKeys;
  items: ReadonlyArray<NavLeaf>;
};

/** The Home route — everyone lands here after sign-in. */
export const homePath = "/";

/**
 * The navigation model, shared by the sidebar and the command palette. Sections are labelled,
 * always-open blocks (never collapsible groups): every leaf is always in the DOM, so tests and
 * deep links address the links directly, and a static label costs less vertical space than a
 * toggle. Home, Plan, Roadmap, Programs, Baselines and Deviations (the Planning section, readable by everyone) are visible to everyone; the Administration section holds Teams, People and Public holidays (everyone reads
 * the flat teams list, the people directory and the holiday dictionary; only their create/edit/delete are ADMIN) alongside the ADMIN-only Users,
 * Feature flags, Jira and Flow (the connections registries) leaves — a non-admin session sees just Teams, People and Public holidays there.
 */
const NAV_SECTIONS: ReadonlyArray<NavSection> = [
  {
    label: "appShell.section.overview",
    items: [{ to: homePath, label: "appShell.nav.home", icon: IconHome2 }],
  },
  {
    label: "appShell.section.planning",
    items: [
      { to: planPath, label: "appShell.nav.plan", icon: IconSitemap },
      { to: roadmapPath, label: "appShell.nav.roadmap", icon: IconListNumbers },
      { to: programsPath, label: "appShell.nav.programs", icon: IconListTree },
      { to: baselinesPath, label: "appShell.nav.baselines", icon: IconCamera },
      { to: deviationsPath, label: "appShell.nav.deviations", icon: IconGitCompare },
    ],
  },
  {
    label: "appShell.section.administration",
    items: [
      { to: teamsPath, label: "appShell.nav.teams", icon: IconUsersGroup },
      { to: peoplePath, label: "appShell.nav.people", icon: IconAddressBook },
      { to: publicHolidaysPath, label: "appShell.nav.publicHolidays", icon: IconCalendarOff },
      { to: usersPath, label: "appShell.nav.users", icon: IconUsers, adminOnly: true },
      { to: "/feature-flags", label: "appShell.nav.featureFlags", icon: IconToggleLeft, adminOnly: true },
      { to: jiraConnectionsPath, label: "appShell.nav.jira", icon: IconPlugConnected, adminOnly: true },
      { to: flowConnectionsPath, label: "appShell.nav.flow", icon: IconActivity, adminOnly: true, keywords: ["flow", "capacity", "roster"] },
    ],
  },
];

/** Account-scoped leaves: the header user menu and the palette render them, the sidebar never. */
export const ACCOUNT_NAV: ReadonlyArray<NavLeaf> = [
  { to: "/change-password", label: "appShell.nav.changePassword", icon: IconKey },
  { to: "/changelog", label: "appShell.nav.changelog", icon: IconHistory },
];

/** The sections a session may see: admin-only leaves filtered, empty sections dropped. */
export function visibleSections(admin: boolean): NavSection[] {
  return NAV_SECTIONS.flatMap((section) => {
    const items = section.items.filter((leaf) => !leaf.adminOnly || admin);
    return items.length > 0 ? [{ ...section, items }] : [];
  });
}

/**
 * Longest-matching-prefix active-link resolution — "/" only matches exactly. A leaf matches on its
 * own `to` and on every `activeFor` route; the answer is always the leaf's `to`.
 */
export function activeNavPath(pathname: string, leaves: ReadonlyArray<NavLeaf>): string | null {
  const matches = (path: string) =>
    path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`);
  return (
    leaves
      .flatMap((leaf) => [leaf.to, ...(leaf.activeFor ?? [])].filter(matches).map((path) => ({ to: leaf.to, length: path.length })))
      .sort((a, b) => b.length - a.length)[0]?.to ?? null
  );
}
