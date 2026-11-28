import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { refreshQueriesAfterMutation } from "./queryRefresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("refreshes active initial reads across prefixes, invalidates inactive data and leaves unrelated reads intact", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const oldTeams = deferred<string>();
  const oldSystems = deferred<string>();
  const user = deferred<string>();
  const teams = vi.fn().mockImplementationOnce(() => oldTeams.promise).mockResolvedValue("new teams");
  const systems = vi.fn().mockImplementationOnce(() => oldSystems.promise).mockResolvedValue("new systems");
  const users = vi.fn(() => user.promise);
  const subscriptions = [
    new QueryObserver(client, { queryKey: ["teams", "list"], queryFn: teams }).subscribe(() => undefined),
    new QueryObserver(client, { queryKey: ["systems", "list"], queryFn: systems }).subscribe(() => undefined),
    new QueryObserver(client, { queryKey: ["users", "list"], queryFn: users }).subscribe(() => undefined),
  ];
  client.setQueryData(["systems", "detail", 7], "cached system");
  try {
    await vi.waitFor(() => { expect(teams).toHaveBeenCalledTimes(1); expect(systems).toHaveBeenCalledTimes(1); });
    await refreshQueriesAfterMutation(client, ["teams"], ["systems"]);
    expect(teams).toHaveBeenCalledTimes(2);
    expect(systems).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(["teams", "list"])).toBe("new teams");
    expect(client.getQueryData(["systems", "list"])).toBe("new systems");
    expect(client.getQueryState(["systems", "detail", 7])?.isInvalidated).toBe(true);
    expect(client.getQueryData(["systems", "detail", 7])).toBe("cached system");
    expect(users).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(["users", "list"])?.fetchStatus).toBe("fetching");
    oldTeams.resolve("old teams");
    oldSystems.resolve("old systems");
    user.resolve("user result");
    await vi.waitFor(() => expect(client.getQueryData(["users", "list"])).toBe("user result"));
    expect(client.getQueryData(["teams", "list"])).toBe("new teams");
    expect(client.getQueryData(["systems", "list"])).toBe("new systems");
  } finally {
    oldTeams.resolve("old teams");
    oldSystems.resolve("old systems");
    user.resolve("user result");
    subscriptions.forEach((unsubscribe) => unsubscribe());
    client.clear();
  }
});

/** A client holding every kind of team entry, one of them (team 1, baseline 7) watched by a mounted page. */
function clientWithTeamViews() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(["plan", "team", 1, { baseline: null, chain: true }], "sibling");
  client.setQueryData(["plan", "team", 1, { baseline: 5, chain: false }], "another sibling");
  client.setQueryData(["plan", "team", 2, { baseline: null, chain: false }], "another team");
  client.setQueryData(["plan", "project", 1, { baseline: null }], "a project");
  client.setQueryData(["roadmap", "view"], "the roadmap");
  client.setQueryData(["plan", "team", 1, { baseline: 7, chain: false }], "shown");
  const shown = new QueryObserver(client, { queryKey: ["plan", "team", 1, { baseline: 7, chain: false }], queryFn: () => "refetched" }).subscribe(() => undefined);
  return { client, shown };
}

test.each([[["plan"]], [["plan", "team"]]])("a refresh of %j removes every INACTIVE team view of every team, synchronously, and keeps the mounted one and every other read", async (...keys) => {
  const { client, shown } = clientWithTeamViews();
  try {
    const refreshed = refreshQueriesAfterMutation(client, ...(keys as unknown as [string[]]));
    // before anything is awaited
    expect(client.getQueryData(["plan", "team", 1, { baseline: null, chain: true }])).toBeUndefined();
    expect(client.getQueryData(["plan", "team", 1, { baseline: 5, chain: false }])).toBeUndefined();
    expect(client.getQueryData(["plan", "team", 2, { baseline: null, chain: false }])).toBeUndefined();
    await refreshed;
    expect(client.getQueryData(["plan", "team", 1, { baseline: 7, chain: false }])).toBe("refetched");
    expect(client.getQueryData(["plan", "project", 1, { baseline: null }])).toBe("a project");
    expect(client.getQueryData(["roadmap", "view"])).toBe("the roadmap");
  } finally {
    shown();
    client.clear();
  }
});

test("a refresh that does not cover the team views keeps them, however many keys it names", async () => {
  const { client, shown } = clientWithTeamViews();
  try {
    await refreshQueriesAfterMutation(client, ["roadmap"], ["jira"], ["plan", "project"], ["plan", "team", 1, { baseline: 5, chain: false }]);
    expect(client.getQueryData(["plan", "team", 1, { baseline: null, chain: true }])).toBe("sibling");
    expect(client.getQueryData(["plan", "team", 1, { baseline: 5, chain: false }])).toBe("another sibling");
    expect(client.getQueryData(["plan", "team", 2, { baseline: null, chain: false }])).toBe("another team");
  } finally {
    shown();
    client.clear();
  }
});

test("one covering key among several is enough: the team views go with a Jira, plan and roadmap refresh", async () => {
  const { client, shown } = clientWithTeamViews();
  try {
    await refreshQueriesAfterMutation(client, ["jira"], ["plan"], ["roadmap"]);
    expect(client.getQueryData(["plan", "team", 2, { baseline: null, chain: false }])).toBeUndefined();
    expect(client.getQueryData(["plan", "team", 1, { baseline: 7, chain: false }])).toBe("refetched");
  } finally {
    shown();
    client.clear();
  }
});
