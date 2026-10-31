// Milestones API (`/api/v1/projects/{id}/milestones`, `/milestones/{id}`, `/milestones/{id}/schedule`, `/views/project/{id}`, V14) —
// the fourth level of the plan. Everyone signed in reads the project view; the `can` flags inside it say what the caller may do
// (the owner chain edits a milestone's plan fields, ONLY its team's manager or an ADMIN sets its dates), and the server's guards
// are the rule. Thin endpoint wrappers: transport (authedFetch/ApiError) in ./http, types from ./schema.

import { jsonRequest, voidRequest } from "./http";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type ProjectView = Schemas["ProjectView"];
export type ProjectMilestone = Schemas["ProjectMilestone"];
export type MilestoneBody = Schemas["MilestoneCreateRequest"] & Schemas["MilestoneUpdateRequest"];
export type ScheduleBody = Schemas["MilestoneScheduleRequest"];

export async function getProjectView(projectId: number): Promise<ProjectView> {
  return jsonRequest<ProjectView>(`/api/v1/views/project/${projectId}`);
}

export async function createMilestone(projectId: number, body: MilestoneBody): Promise<Schemas["MilestoneResponse"]> {
  return jsonRequest<Schemas["MilestoneResponse"]>(`/api/v1/projects/${projectId}/milestones`, { method: "POST", body: JSON.stringify(body) });
}

/** A full replace of the plan fields (never the dates). */
export async function updateMilestone(id: number, body: MilestoneBody): Promise<void> {
  await voidRequest(`/api/v1/milestones/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

export async function deleteMilestone(id: number): Promise<void> {
  await voidRequest(`/api/v1/milestones/${id}`, { method: "DELETE" });
}

/** The dates, team manager / ADMIN only: both dates or neither (a null pair unschedules). Answers the plan revision after the write. */
export async function scheduleMilestone(id: number, body: ScheduleBody): Promise<Schemas["ScheduleResponse"]> {
  return jsonRequest<Schemas["ScheduleResponse"]>(`/api/v1/milestones/${id}/schedule`, { method: "PUT", body: JSON.stringify(body) });
}
