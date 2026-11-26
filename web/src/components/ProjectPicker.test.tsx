import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import { Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import ProjectPicker from "./ProjectPicker";
import { routeFetch } from "../test/http";
import { planOf } from "../test/planView";
import { renderWithProviders } from "../test/render";

const PLAN = planOf([
  {
    id: 2,
    name: "Platform",
    programs: [
      { id: 21, name: "Billing", projects: [{ id: 211, name: "Invoices", ownerName: "Ola Owner" }, { id: 213, name: "Reports", ownerName: "Żaneta Żółw" }] },
      { id: 20, name: "Access", projects: [{ id: 201, name: "Login", ownerName: "Piotr Project" }] },
    ],
  },
  { id: 1, name: "Legacy", endDate: "2026-06-30", programs: [{ id: 11, name: "Archive", projects: [{ id: 111, name: "Migration", ownerName: "Ola Owner" }] }] },
]);

/** Where the router is, and how it got there (a push or a replace). */
function Where() {
  const location = useLocation();
  return <p>{`at ${location.pathname} by ${useNavigationType()}`}</p>;
}

function renderPicker(projectId: number | null, currentName?: string) {
  vi.stubGlobal("fetch", routeFetch({ "GET /api/v1/views/plan": PLAN }));
  return renderWithProviders(
    <>
      <ProjectPicker projectId={projectId} currentName={currentName} />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </>,
    { route: "/projects/211" },
  );
}

const picker = () => screen.getByRole("combobox", { name: "Project" });

beforeEach(() => localStorage.setItem("astrolabe.auth.token", "fake-token"));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("ProjectPicker", () => {
  test("it shows the project it is given, named 'Project', and offers no way to clear it", async () => {
    renderPicker(211);
    await vi.waitFor(() => expect(picker()).toHaveValue("Invoices"));
    expect(screen.queryByRole("button", { name: /clear/i })).not.toBeInTheDocument();
  });

  test("the options are grouped 'Work stream › Program', a closed work stream marked", async () => {
    const user = userEvent.setup();
    renderPicker(null);
    await user.click(picker());
    expect(await screen.findByRole("option", { name: "Invoices" })).toBeInTheDocument();
    const groups = screen.getAllByRole("group").map((g) => [g.getAttribute("aria-label") ?? within(g).queryByText(/›/)?.textContent, within(g).getAllByRole("option").map((o) => o.textContent)]);
    expect(groups).toEqual([
      ["Platform › Access", ["Login"]],
      ["Platform › Billing", ["Invoices", "Reports"]],
      ["Legacy (closed) › Archive", ["Migration"]],
    ]);
  });

  test("typing an owner or a program finds its projects, accents folded", async () => {
    const user = userEvent.setup();
    renderPicker(null);
    await user.click(picker());
    await screen.findByRole("option", { name: "Invoices" });
    const found = async (search: string) => {
      await user.clear(picker());
      await user.type(picker(), search);
      return screen.queryAllByRole("option").map((o) => o.textContent);
    };
    expect(await found("ola")).toEqual(["Invoices", "Migration"]);
    expect(await found("Billing")).toEqual(["Invoices", "Reports"]);
    expect(await found("zolw")).toEqual(["Reports"]);
    expect(await found("legacy")).toEqual(["Migration"]);
    expect(await found("nothing like this")).toEqual([]);
    expect(screen.getByText("No project matches")).toBeInTheDocument();
  });

  test("a pick is a push to the project's page", async () => {
    const user = userEvent.setup();
    renderPicker(211);
    await user.click(picker());
    await user.click(await screen.findByRole("option", { name: "Login" }));
    expect(await screen.findByText("at /projects/201 by PUSH")).toBeInTheDocument();
  });

  test("picking the project already shown goes nowhere", async () => {
    const user = userEvent.setup();
    renderPicker(211);
    await user.click(picker());
    await user.click(await screen.findByRole("option", { name: "Invoices" }));
    expect(screen.getByText("at /projects/211 by POP")).toBeInTheDocument();
    expect(picker()).toHaveValue("Invoices");
  });

  test("a project the plan does not hold is still named by the page that has loaded it", async () => {
    renderPicker(999, "Elsewhere");
    await vi.waitFor(() => expect(picker()).toHaveValue("Elsewhere"));
  });
});
