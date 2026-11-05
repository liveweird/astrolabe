import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor } from "../test/render";
import i18n from "../i18n";
import { RedirectIfAuthed, RequireAuth } from "../auth";
import Login from "../pages/Login";
import UserMenu from "./UserMenu";

const ME = { id: 7, name: "Alice Admin", email: "alice@astrolabe.local", roles: ["ADMIN"], disabledFeatures: [], language: "en" };

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response | undefined) {
  const mockFetch = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve(handler(url, init) ?? new Response(null, { status: 204 })),
  );
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderMenu() {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<UserMenu />} />
      <Route path="/login" element={<p>login page</p>} />
    </Routes>,
  );
}

function renderProtectedMenu() {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<RedirectIfAuthed><Login /></RedirectIfAuthed>} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<p>home page</p>} />
        <Route path="/contracts/:id" element={<UserMenu />} />
      </Route>
    </Routes>,
    { route: "/contracts/7" },
  );
}

describe("UserMenu", () => {
  beforeEach(() => {
    localStorage.setItem("astrolabe.auth.token", "fake-token");
    localStorage.setItem("astrolabe.auth.userId", "7");
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.removeAttribute("data-mantine-color-scheme");
    await i18n.changeLanguage("en");
  });

  test("shows the signed-in identity from GET /users/{id} with the admin marker", async () => {
    stubFetch((url) => (url === "/api/v1/users/7" ? Response.json(ME) : undefined));
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: /account menu/i }));
    expect(await screen.findByText("alice@astrolabe.local")).toBeInTheDocument();
    expect(screen.getAllByText("Alice Admin").length).toBeGreaterThan(0);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Change password" })).toHaveAttribute("href", "/change-password");
    expect(screen.getByRole("menuitem", { name: /Changelog/ })).toHaveAttribute("href", "/changelog");
  });

  test("an admin's menu has the Telemetry panel toggle: a check mark and aria-current while it is on, off again on the next pick", async () => {
    stubFetch(() => undefined);
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: /account menu/i }));
    expect(await screen.findByRole("menuitem", { name: "Telemetry panel" })).not.toHaveAttribute("aria-current");
    await user.click(screen.getByRole("menuitem", { name: "Telemetry panel" }));
    expect(localStorage.getItem("astrolabe.viewSettings.telemetry.panelOpen")).toBe("true");
    await user.click(screen.getByRole("button", { name: /account menu/i }));
    expect(await screen.findByRole("menuitem", { name: "Telemetry panel" })).toHaveAttribute("aria-current", "true");
    await user.click(screen.getByRole("menuitem", { name: "Telemetry panel" }));
    expect(localStorage.getItem("astrolabe.viewSettings.telemetry.panelOpen")).toBe("false");
  });

  test("a regular user's menu has no Telemetry panel item", async () => {
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["USER"]));
    stubFetch(() => undefined);
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: /account menu/i }));
    expect(await screen.findByRole("menuitem", { name: "Change password" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Telemetry panel" })).not.toBeInTheDocument();
  });

  test("lists every language by its native name; a pick switches the UI and saves server-side", async () => {
    const mockFetch = stubFetch((url) => (url === "/api/v1/users/7" ? Response.json(ME) : undefined));
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: /account menu/i }));
    expect(await screen.findByRole("menuitem", { name: "English" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("menuitem", { name: "Polski" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Polski" }));
    expect(i18n.resolvedLanguage).toBe("pl");
    await waitFor(() => {
      const call = mockFetch.mock.calls.find(([url]) => url === "/api/v1/users/7/language");
      expect(call).toBeDefined();
      expect((call![1] as RequestInit).method).toBe("PUT");
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ language: "pl" });
    });
  });

  test("without a session userId no identity fetch and no language save happen", async () => {
    localStorage.removeItem("astrolabe.auth.userId");
    const mockFetch = stubFetch(() => undefined);
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: /account menu/i }));
    await user.click(await screen.findByRole("menuitem", { name: "Polski" }));
    expect(i18n.resolvedLanguage).toBe("pl");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("the theme control switches the colour scheme without closing the menu", async () => {
    stubFetch(() => undefined);
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: /account menu/i }));
    await user.click(await screen.findByRole("radio", { name: "Dark" }));
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-mantine-color-scheme")).toBe("dark"),
    );
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });

  test("Sign out from a protected route starts the next session at home without waiting for revocation", async () => {
    const revokeResponse = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/v1/users/7") return Promise.resolve(Response.json(ME));
      if (url === "/api/v1/logout") return revokeResponse.promise;
      if (url === "/api/v1/login" && init?.method === "POST") {
        return Promise.resolve(Response.json({
          token: "next-token",
          expiresAt: 1,
          refreshToken: "next-refresh",
          refreshExpiresAt: 2,
          userId: 7,
          roles: ["ADMIN"],
          disabledFeatures: [],
          language: "en",
        }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }));
    const user = userEvent.setup();
    renderProtectedMenu();
    await user.click(screen.getByRole("button", { name: /account menu/i }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(localStorage.getItem("astrolabe.auth.token")).toBeNull());
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Email" }), "alice@astrolabe.local");
    await user.type(screen.getByLabelText("Password"), "new-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("home page")).toBeInTheDocument();
    expect(localStorage.getItem("astrolabe.auth.token")).toBe("next-token");
    revokeResponse.resolve(new Response(null, { status: 204 }));
    await waitFor(() => expect(localStorage.getItem("astrolabe.auth.token")).toBe("next-token"));
  });

  describe("Tab in the open menu", () => {
    function renderBetweenButtons() {
      return renderWithProviders(
        <Routes>
          <Route
            path="/"
            element={
              <>
                <button>Before</button>
                <UserMenu />
                <button>After</button>
              </>
            }
          />
        </Routes>,
      );
    }

    async function openMenu(user: ReturnType<typeof userEvent.setup>) {
      const trigger = screen.getByRole("button", { name: /account menu/i });
      trigger.focus();
      await user.keyboard("{Enter}");
      await screen.findByRole("menuitem", { name: "English" });
      return trigger;
    }

    test("opened from the keyboard, the menu takes the focus on its first item, not on a radio of the theme switch", async () => {
      stubFetch(() => undefined);
      const user = userEvent.setup();
      renderBetweenButtons();
      await openMenu(user);
      await waitFor(() => expect(screen.getByRole("menuitem", { name: "English" })).toHaveFocus());
    });

    test("Tab from a language item moves on to the theme control (the menu's only Tab stop) and the menu stays open", async () => {
      stubFetch(() => undefined);
      const user = userEvent.setup();
      renderBetweenButtons();
      await openMenu(user);
      screen.getByRole("menuitem", { name: "English" }).focus();
      await user.keyboard("{Tab}");
      expect(screen.getByRole("radio", { checked: true })).toHaveFocus();
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    test("Tab from the theme control, the last Tab stop, closes the menu and moves on from the trigger", async () => {
      stubFetch(() => undefined);
      const user = userEvent.setup();
      renderBetweenButtons();
      await openMenu(user);
      screen.getByRole("radio", { checked: true }).focus();
      await user.keyboard("{Tab}");
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
    });

    test("Shift+Tab from the first item, with no Tab stop before it, closes the menu and moves back from the trigger", async () => {
      stubFetch(() => undefined);
      const user = userEvent.setup();
      renderBetweenButtons();
      await openMenu(user);
      screen.getByRole("menuitem", { name: "English" }).focus();
      await user.keyboard("{Shift>}{Tab}{/Shift}");
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(screen.getByRole("button", { name: "Before" })).toHaveFocus();
    });

    test("Tab from an item after the theme control closes the menu (nothing further to Tab to); Shift+Tab there goes back to the theme control", async () => {
      stubFetch(() => undefined);
      const user = userEvent.setup();
      renderBetweenButtons();
      await openMenu(user);
      screen.getByRole("menuitem", { name: "Change password" }).focus();
      await user.keyboard("{Shift>}{Tab}{/Shift}");
      expect(screen.getByRole("radio", { checked: true })).toHaveFocus();
      expect(screen.getByRole("menu")).toBeInTheDocument();
      screen.getByRole("menuitem", { name: "Change password" }).focus();
      await user.keyboard("{Tab}");
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
    });
  });
});
