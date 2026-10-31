import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { notifications } from "@mantine/notifications";
import UserPermissions from "./UserPermissions";
import { jsonResponse } from "../test/http";
import { renderWithProviders } from "../test/render";

const TOKEN_KEY = "astrolabe.auth.token";
const ROLES_KEY = "astrolabe.auth.roles";

type FetchMock = ReturnType<typeof vi.fn>;

function PathProbe() {
  const location = useLocation();
  return <div data-testid="probe">{location.pathname}</div>;
}

function renderPage(id: number | string = 7) {
  return renderWithProviders(
    <Routes>
      <Route path="/users/:id/permissions" element={<UserPermissions />} />
      <Route path="/users" element={<PathProbe />} />
    </Routes>,
    { route: `/users/${id}/permissions` },
  );
}

const USER_WITHOUT_GRANT = {
  id: 7,
  name: "Alice",
  email: "alice@example.com",
  roles: [] as string[],
  disabledFeatures: [] as string[],
  language: "en",
  permissions: [] as string[],
};

describe("UserPermissions page", () => {
  let mockFetch: FetchMock;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem(TOKEN_KEY, "fake-token");
    localStorage.setItem(ROLES_KEY, JSON.stringify(["ADMIN"]));
  });

  afterEach(() => {
    // isolate:false — a spy on the shared `notifications` singleton must not outlive its test.
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function mockApi({
    user = USER_WITHOUT_GRANT,
    userStatus = 200,
    putStatus = 204,
  }: { user?: typeof USER_WITHOUT_GRANT; userStatus?: number; putStatus?: number } = {}) {
    mockFetch.mockImplementation((_input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") {
        return Promise.resolve(
          putStatus === 204
            ? new Response(null, { status: 204 })
            : jsonResponse(putStatus, { title: "err", status: putStatus }),
        );
      }
      return Promise.resolve(
        userStatus === 200
          ? jsonResponse(200, user)
          : jsonResponse(userStatus, { title: "not found", status: userStatus }),
      );
    });
  }

  test("renders the roadmap-editor switch seeded from the granted set (a row = checked)", async () => {
    mockApi({ user: { ...USER_WITHOUT_GRANT, permissions: ["ROADMAP_EDITOR"] } });
    renderPage(7);
    const editor = (await screen.findByRole("switch", { name: /roadmap editor/i })) as HTMLInputElement;
    expect(editor.checked).toBe(true);
  });

  test("granting and saving PUTs the wholesale granted set, toasts, and returns to /users", async () => {
    mockApi();
    const showSpy = vi.spyOn(notifications, "show");
    const user = userEvent.setup();
    renderPage(7);

    const editor = (await screen.findByRole("switch", { name: /roadmap editor/i })) as HTMLInputElement;
    expect(editor.checked).toBe(false);
    await user.click(editor);
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("/users"));
    const putCall = mockFetch.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PUT");
    expect(putCall![0]).toBe("/api/v1/users/7/permissions");
    expect(JSON.parse((putCall![1] as { body: string }).body)).toEqual({ permissions: ["ROADMAP_EDITOR"] });
    expect(showSpy).toHaveBeenCalledWith(expect.objectContaining({ message: "Permissions saved" }));
  });

  test("revoking and saving PUTs the empty set", async () => {
    mockApi({ user: { ...USER_WITHOUT_GRANT, permissions: ["ROADMAP_EDITOR"] } });
    const user = userEvent.setup();
    renderPage(7);

    await user.click(await screen.findByRole("switch", { name: /roadmap editor/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("/users"));
    const putCall = mockFetch.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PUT");
    expect(JSON.parse((putCall![1] as { body: string }).body)).toEqual({ permissions: [] });
  });

  test("a grant this page has no switch for is carried over in the wholesale PUT", async () => {
    // A newer server may know a permission this SPA build does not list; saving must never silently revoke it.
    mockApi({ user: { ...USER_WITHOUT_GRANT, permissions: ["FUTURE_PERMISSION"] } });
    const user = userEvent.setup();
    renderPage(7);

    await user.click(await screen.findByRole("switch", { name: /roadmap editor/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("/users"));
    const putCall = mockFetch.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PUT");
    expect(JSON.parse((putCall![1] as { body: string }).body)).toEqual({
      permissions: ["ROADMAP_EDITOR", "FUTURE_PERMISSION"],
    });
  });

  test("a failing save shows an inline error and stays on the page", async () => {
    mockApi({ putStatus: 500 });
    const user = userEvent.setup();
    renderPage(7);

    await user.click(await screen.findByRole("switch", { name: /roadmap editor/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText("Saving the permissions failed (500)")).toBeInTheDocument();
    expect(screen.queryByTestId("probe")).toBeNull();
  });

  test("a 404 user shows the not-found state", async () => {
    mockApi({ userStatus: 404 });
    renderPage(7);
    expect(await screen.findByText("User not found.")).toBeInTheDocument();
  });

  test("a non-numeric id redirects without fetching the user", () => {
    mockApi();
    renderPage("abc");
    expect(screen.getByTestId("probe")).toHaveTextContent("/users");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
