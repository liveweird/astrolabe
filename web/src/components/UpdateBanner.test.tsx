import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor } from "../test/render";
import i18n from "../i18n";
import UpdateBanner from "./UpdateBanner";

function stubServed(commit: string) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(`<meta name="astrolabe-build" content="${commit}">`, { status: 200 }))));
}

describe("UpdateBanner", () => {
  beforeEach(() => {
    vi.stubGlobal("__APP_COMMIT__", "bundle1");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await i18n.changeLanguage("en");
  });

  test("renders nothing while the served build is this tab's own", async () => {
    stubServed("bundle1");
    renderWithProviders(<UpdateBanner />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(() => Promise.resolve());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
  });

  test("another served build shows the status line and a Reload button that reloads", async () => {
    stubServed("other99");
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    renderWithProviders(<UpdateBanner />);
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("A new version of Astrolabe is available. Reload the page to use it.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("speaks Polish", async () => {
    await i18n.changeLanguage("pl");
    stubServed("other99");
    renderWithProviders(<UpdateBanner />);
    expect(await screen.findByRole("status")).toHaveTextContent("Jest dostępna nowa wersja Astrolabe. Odśwież stronę, żeby z niej korzystać.");
    expect(screen.getByRole("button", { name: "Odśwież" })).toBeInTheDocument();
  });
});
