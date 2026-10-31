import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { renderWithProviders, screen } from "../test/render";
import CommandPalette from "./CommandPalette";
import { palette } from "../utils/commandPalette";

function Probe() {
  const { pathname } = useLocation();
  return <p>at {pathname}</p>;
}

function renderPalette() {
  return renderWithProviders(
    <>
      <CommandPalette />
      <Routes>
        <Route path="*" element={<Probe />} />
      </Routes>
    </>,
  );
}

describe("CommandPalette", () => {
  beforeEach(() => {
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });

  afterEach(() => {
    palette.close();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("the header trigger opens the palette listing the session's pages", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    renderPalette();
    // Label in Name (WCAG 2.5.3): the wide trigger is named by its visible words, with no aria-label of its own.
    await user.click(screen.getByRole("button", { name: /^Search or jump to a page…/ }));
    expect(await screen.findByRole("button", { name: /Home/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Change password/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Teams$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^People$/ })).toBeInTheDocument();
    // A regular session never sees the admin pages.
    expect(screen.queryByRole("button", { name: /^Users$/ })).not.toBeInTheDocument();
  });

  test("an admin session's palette includes the Administration pages, and a pick navigates", async () => {
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    renderPalette();
    palette.open();
    await user.click(await screen.findByRole("button", { name: /Users/ }));
    expect(await screen.findByText("at /users")).toBeInTheDocument();
  });

  test("an admin's palette has the telemetry action, which toggles the panel flag and says what it will do", async () => {
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    renderPalette();
    palette.open();
    await user.click(await screen.findByRole("button", { name: /Show telemetry panel/ }));
    expect(localStorage.getItem("astrolabe.viewSettings.telemetry.panelOpen")).toBe("true");
    palette.open();
    await user.click(await screen.findByRole("button", { name: /Hide telemetry panel/ }));
    expect(localStorage.getItem("astrolabe.viewSettings.telemetry.panelOpen")).toBe("false");
  });

  test("the telemetry action is found by its keywords, not only its label", async () => {
    localStorage.setItem("astrolabe.auth.roles", JSON.stringify(["ADMIN"]));
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    renderPalette();
    palette.open();
    await user.type(await screen.findByPlaceholderText("Search or jump to a page…"), "memory");
    expect(await screen.findByRole("button", { name: /Show telemetry panel/ })).toBeInTheDocument();
  });

  test("a regular session's palette has no telemetry action", async () => {
    vi.stubGlobal("fetch", vi.fn());
    renderPalette();
    palette.open();
    await screen.findByRole("button", { name: /Home/ });
    expect(screen.queryByRole("button", { name: /telemetry/i })).not.toBeInTheDocument();
  });

  test("typing narrows the list to pages matching the folded query", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    renderPalette();
    palette.open();
    await user.type(await screen.findByRole("textbox"), "team");
    expect(await screen.findByRole("button", { name: /Teams/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Change password/ })).not.toBeInTheDocument();
  });
});
