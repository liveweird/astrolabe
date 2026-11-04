import { Suspense, useEffect, useState } from "react";
import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { useFocusMainOnNavigation } from "./useFocusMainOnNavigation";

function Frame() {
  useFocusMainOnNavigation();
  const navigate = useNavigate();
  return (
    <>
      <nav>
        <Link to="/plain">plain</Link>
        <Link to="/plain?baseline=3">plain with query</Link>
        <Link to="/field">field</Link>
        <Link to="/late">late</Link>
        <button type="button" onClick={() => navigate("/plain")}>
          push same path
        </button>
      </nav>
      <main id="main-content" tabIndex={-1}>
        <button type="button" onClick={() => navigate("/plain")}>
          go from main
        </button>
        <Suspense fallback={<p>loading</p>}>
          <Outlet />
        </Suspense>
      </main>
    </>
  );
}

// A page whose field mounts AFTER the frame's effect ran (a lazy chunk or a loaded-data form): the test says when. React Router wraps a
// navigation in a transition, so a not-yet-loaded route chunk holds the old page and commits with the shell's pathname - the late mount is
// therefore simulated with state instead of a real `lazy` suspension.
const late = { release: () => {} };
function Late() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    late.release = () => setReady(true);
  }, []);
  return ready ? <input aria-label="late field" autoFocus /> : <p>loading</p>;
}

function renderFrame(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route element={<Frame />}>
          <Route index element={<p>home</p>} />
          <Route path="plain" element={<p>plain page</p>} />
          <Route path="field" element={<input aria-label="field" autoFocus />} />
          <Route path="late" element={<Late />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const main = () => document.getElementById("main-content");

describe("useFocusMainOnNavigation", () => {
  test("the first render leaves the focus where it was (the document start)", () => {
    renderFrame("/");
    expect(document.activeElement).toBe(document.body);
  });

  test("a pathname change focuses the main area, without scrolling", async () => {
    const user = userEvent.setup();
    renderFrame("/");
    const focus = vi.spyOn(main()!, "focus");
    await user.click(screen.getByRole("link", { name: "plain" }));
    expect(await screen.findByText("plain page")).toBeInTheDocument();
    expect(main()).toHaveFocus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  test("a query-string change and a push of the same path never move the focus", async () => {
    const user = userEvent.setup();
    renderFrame("/plain");
    const link = screen.getByRole("link", { name: "plain with query" });
    await user.click(link);
    expect(link).toHaveFocus();
    const push = screen.getByRole("button", { name: "push same path" });
    await user.click(push);
    expect(push).toHaveFocus();
  });

  test("a field that autofocuses in the same commit keeps the focus (the child's autoFocus runs first)", async () => {
    const user = userEvent.setup();
    renderFrame("/");
    await user.click(screen.getByRole("link", { name: "field" }));
    expect(await screen.findByLabelText("field")).toHaveFocus();
  });

  test("a field that mounts after the effect: main takes the focus first, then the page's autoFocus takes it", async () => {
    const user = userEvent.setup();
    renderFrame("/");
    await user.click(screen.getByRole("link", { name: "late" }));
    expect(screen.getByText("loading")).toBeInTheDocument();
    expect(main()).toHaveFocus();
    await act(async () => {
      late.release();
    });
    expect(await screen.findByLabelText("late field")).toHaveFocus();
  });

  test("a focus already inside main is left alone", async () => {
    const user = userEvent.setup();
    renderFrame("/");
    // A control that lives in the main area and navigates (a "New ..." button) keeps the focus it was clicked with.
    const inMain = screen.getByRole("button", { name: "go from main" });
    await user.click(inMain);
    expect(await screen.findByText("plain page")).toBeInTheDocument();
    expect(inMain).toHaveFocus();
  });
});
