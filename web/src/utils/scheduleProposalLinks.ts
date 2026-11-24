/** The ONE place the schedule-proposals route is spelled out. */
export const scheduleProposalsPath = "/schedule-proposals";

/** One saved proposal's page. */
export const savedScheduleProposalPath = (id: number) => `${scheduleProposalsPath}/saved/${id}`;
