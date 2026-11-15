import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../test/http";
import { renderWithProviders, screen, waitFor } from "../test/render";
import ProjectFilterSelect from "./ProjectFilterSelect";

const PLAN = {
  revision: 1,
  workStreams: [
    {
      id: 700,
      name: "Platform",
      programs: [
        { id: 70, name: "Billing", projects: [{ id: 7, name: "Invoices" }, { id: 8, name: "Checkout" }] },
        { id: 71, name: "Search", projects: [{ id: 9, name: "Checkout" }] },
      ],
    },
  ],
};

let answer: () => Response | Promise<Response>;
let mockFetch: ReturnType<typeof vi.fn>;

describe("ProjectFilterSelect", () => {
  beforeEach(() => {
    answer = () => jsonResponse(200, PLAN);
    mockFetch = vi.fn(() => Promise.resolve(answer()));
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("lists every project of the plan, two of one name told apart by their program, and a pick calls onChange with the id", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ProjectFilterSelect projectId={undefined} onChange={onChange} />);
    const field = screen.getByRole("combobox", { name: "Project" });
    await user.click(field);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Checkout (Billing)", "Checkout (Search)", "Invoices"]);
    await user.click(screen.getByRole("option", { name: "Invoices" }));
    expect(onChange).toHaveBeenCalledWith(7);
  });

  test("the clear button calls onChange with undefined", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ProjectFilterSelect projectId={7} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("Invoices"));
    await user.click(screen.getByLabelText("Clear project filter"));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  test("an id the settled plan does not hold is shown as Project N", async () => {
    renderWithProviders(<ProjectFilterSelect projectId={99} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("Project 99"));
  });

  test("while the plan has not answered, or failed, the field is blank and no such option exists", async () => {
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    renderWithProviders(<ProjectFilterSelect projectId={99} onChange={vi.fn()} />);
    const field = screen.getByRole("combobox", { name: "Project" });
    expect(field).toHaveValue("");
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(field).toHaveValue("");
  });
});
