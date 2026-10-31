// People API (`/api/v1/people`, V10) — the directory of the people who own plan nodes and manage teams, optionally linked
// to a login. Any authenticated user reads it (the owner and manager pickers, the People page); ADMIN curates it.
// Thin endpoint wrappers: transport (authedFetch/ApiError) in ./http, types from ./schema.

import { buildQuery, jsonRequest, voidRequest } from "./http";
import type { paths } from "./schema";

export type PersonPage = paths["/api/v1/people"]["get"]["responses"]["200"]["content"]["application/json"];
export type PersonListItem = PersonPage["items"][number];
export type PersonResponse = paths["/api/v1/people/{id}"]["get"]["responses"]["200"]["content"]["application/json"];
export type PersonCreateBody = paths["/api/v1/people"]["post"]["requestBody"]["content"]["application/json"];
export type PersonUpdateBody = paths["/api/v1/people/{id}"]["put"]["requestBody"]["content"]["application/json"];

type PersonListQuery = {
  page: number;
  pageSize: number;
  sort?: string;
  name?: string;
  email?: string;
};

export async function listPeople(q: PersonListQuery): Promise<PersonPage> {
  const params = buildQuery({ page: q.page, pageSize: q.pageSize, sort: q.sort, name: q.name, email: q.email });
  return jsonRequest<PersonPage>(`/api/v1/people?${params}`);
}

export async function getPerson(id: number): Promise<PersonResponse> {
  return jsonRequest<PersonResponse>(`/api/v1/people/${id}`);
}

export async function createPerson(body: PersonCreateBody): Promise<PersonResponse> {
  return jsonRequest<PersonResponse>("/api/v1/people", { method: "POST", body: JSON.stringify(body) });
}

export async function updatePerson(id: number, body: PersonUpdateBody): Promise<void> {
  await voidRequest(`/api/v1/people/${id}`, { method: "PUT", body: JSON.stringify(body) });
}

export async function deletePerson(id: number): Promise<void> {
  await voidRequest(`/api/v1/people/${id}`, { method: "DELETE" });
}
