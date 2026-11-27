import { useEffect, useMemo, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createPath, Router, useLocation, useNavigate, type Navigator, type To } from "react-router-dom";
import EmptyPlanSavedNotice from "./EmptyPlanSavedNotice";
import { SAVED_URL } from "../test/crossTeamRun";
import { jsonResponse, routeFetch } from "../test/http";
import { theme } from "../theme";

// The verdict's parameter leaves the address in a router transition (MemoryRouter's `startTransition`), and the verdict holds until it has. A Dismiss in that window must
// still clear the note. This router HOLDS an address change until the test commits it, so the click lands inside the window every time.

const NOTE_ONLY = { ignore: 'script, style, [role="status"]' };

let holding: boolean;
let held: To | null;
let commit: () => void;

function HoldingRouter({ initial, children }: { initial: string; children: ReactNode }) {
  const [location, setLocation] = useState<To>(initial);
  useEffect(() => {
    commit = () => {
      const to = held;
      held = null;
      if (to !== null) setLocation(to);
    };
  }, []);
  const navigator = useMemo<Navigator>(() => {
    const go = (to: To) => {
      if (holding) held = to;
      else setLocation(to);
    };
    return { createHref: (to) => (typeof to === "string" ? to : createPath(to)), push: go, replace: go, go: () => undefined };
  }, []);
  return (
    <Router location={location} navigator={navigator}>
      {children}
    </Router>
  );
}

function Where() {
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="where">{useLocation().search}</output>
      <button onClick={() => void navigate("/roadmap?mode=overview&proposal=6")}>open another</button>
    </>
  );
}
const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  holding = true;
  held = null;
  vi.stubGlobal("fetch", routeFetch({ [`GET ${SAVED_URL}/:id`]: () => jsonResponse(500, { title: "Boom", status: 500 }) }));
  localStorage.setItem("astrolabe.auth.token", "fake-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("EmptyPlanSavedNotice", () => {
  test("Dismiss clears the note even before the address has dropped the parameter; another proposal's address says its verdict again", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MantineProvider env="test" theme={theme}>
        <QueryClientProvider client={queryClient}>
          <HoldingRouter initial="/roadmap?mode=overview&proposal=5">
            <EmptyPlanSavedNotice />
            <Where />
          </HoldingRouter>
        </QueryClientProvider>
      </MantineProvider>,
    );
    expect(await screen.findByText("Load failed (500)", NOTE_ONLY)).toBeInTheDocument();
    // the drop was asked and is held: the address on screen still names the proposal, so the verdict still holds
    await waitFor(() => expect(held).not.toBeNull());
    expect(where()).toBe("?mode=overview&proposal=5");
    await user.click(screen.getByRole("button", { name: "Dismiss this notice" }));
    expect(screen.queryByText("Load failed (500)", NOTE_ONLY)).toBeNull();
    expect(where()).toBe("?mode=overview&proposal=5");
    // the address change lands: the parameter leaves, the note stays dismissed
    holding = false;
    act(() => commit());
    expect(where()).toBe("?mode=overview");
    expect(screen.queryByText("Load failed (500)", NOTE_ONLY)).toBeNull();
    // an address that names a proposal again says its verdict again
    await user.click(screen.getByRole("button", { name: "open another" }));
    expect(await screen.findByText("Load failed (500)", NOTE_ONLY)).toBeInTheDocument();
    await waitFor(() => expect(where()).toBe("?mode=overview"));
    expect(screen.getByText("Load failed (500)", NOTE_ONLY)).toBeInTheDocument();
  });
});
