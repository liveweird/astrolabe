/** The ONE place the Deviations route is spelled out - never hand-assemble the URL (the chips link into it filtered). */
export const deviationsPath = "/deviations";

/** `/deviations?projectId=7`: the page filtered to a project (its own link and its milestones'). */
export const deviationsForProjectPath = (projectId: number) => `${deviationsPath}?projectId=${projectId}`;

/** `/deviations?teamId=3`: the page filtered to a team's milestones. */
export const deviationsForTeamPath = (teamId: number) => `${deviationsPath}?teamId=${teamId}`;
