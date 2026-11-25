import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { jsonResponse } from "../test/http";
import { requestsAnswered } from "../test/requestsAnswered";
import { renderWithProviders, screen, waitFor } from "../test/render";
import PlanFilterSelect from "./PlanFilterSelect";

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

// Two work streams, two programs of one name: the levels above the project.
const WIDE = { revision: 1, workStreams: [...PLAN.workStreams, { id: 701, name: "Growth", programs: [{ id: 72, name: "Search", projects: [{ id: 10, name: "Signup" }] }] }] };

let answer: () => Response | Promise<Response>;
let mockFetch: ReturnType<typeof vi.fn>;

describe("PlanFilterSelect, project level", () => {
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
    renderWithProviders(<PlanFilterSelect level="project" value={undefined} onChange={onChange} />);
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
    renderWithProviders(<PlanFilterSelect level="project" value={7} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("Invoices"));
    await user.click(screen.getByLabelText("Clear project filter"));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  test("an id the settled plan does not hold is shown as Project N", async () => {
    renderWithProviders(<PlanFilterSelect level="project" value={99} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("Project 99"));
  });

  test("while the plan has not answered, or failed, the field is blank and no such option exists", async () => {
    answer = () => jsonResponse(500, { title: "x", status: 500 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderWithProviders(<PlanFilterSelect level="project" value={99} onChange={vi.fn()} />, { queryClient });
    const field = screen.getByRole("combobox", { name: "Project" });
    expect(field).toHaveValue("");
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await requestsAnswered(queryClient);
    expect(field).toHaveValue("");
  });
});

describe("PlanFilterSelect, work stream and program levels", () => {
  beforeEach(() => {
    mockFetch = vi.fn(() => Promise.resolve(jsonResponse(200, WIDE)));
    vi.stubGlobal("fetch", mockFetch);
    localStorage.setItem("astrolabe.auth.token", "fake-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const optionsOf = async (name: string, user: ReturnType<typeof userEvent.setup>, count: number) => {
    await user.click(screen.getByRole("combobox", { name }));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(count));
    return screen.getAllByRole("option").map((option) => option.textContent);
  };

  test("the work stream level lists every work stream under its own label, and a pick calls onChange with the id", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<PlanFilterSelect level="workStream" value={undefined} onChange={onChange} />);
    expect(await optionsOf("Work stream", user, 2)).toEqual(["Growth", "Platform"]);
    await user.click(screen.getByRole("option", { name: "Platform" }));
    expect(onChange).toHaveBeenCalledWith(700);
  });

  test("the program level lists every program, two of one name told apart by their work stream", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanFilterSelect level="program" value={undefined} onChange={vi.fn()} />);
    expect(await optionsOf("Program", user, 3)).toEqual(["Billing", "Search (Growth)", "Search (Platform)"]);
  });

  test("within a work stream the program options narrow to it and the labels stay what they were", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanFilterSelect level="program" value={undefined} onChange={vi.fn()} within={{ workStreamId: 700 }} />);
    expect(await optionsOf("Program", user, 2)).toEqual(["Billing", "Search (Platform)"]);
  });

  test("the project level within a program, and within a work stream", async () => {
    const user = userEvent.setup();
    const first = renderWithProviders(<PlanFilterSelect level="project" value={undefined} onChange={vi.fn()} within={{ programId: 70 }} />);
    expect(await optionsOf("Project", user, 2)).toEqual(["Checkout (Billing)", "Invoices"]);
    first.unmount();
    renderWithProviders(<PlanFilterSelect level="project" value={undefined} onChange={vi.fn()} within={{ workStreamId: 701 }} />);
    expect(await optionsOf("Project", user, 1)).toEqual(["Signup"]);
  });

  test("the clear buttons are named for their level", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const first = renderWithProviders(<PlanFilterSelect level="workStream" value={700} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Work stream" })).toHaveValue("Platform"));
    await user.click(screen.getByLabelText("Clear the work stream filter"));
    expect(onChange).toHaveBeenCalledWith(undefined);
    first.unmount();
    renderWithProviders(<PlanFilterSelect level="program" value={70} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Program" })).toHaveValue("Billing"));
    await user.click(screen.getByLabelText("Clear the program filter"));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  test("a value the plan holds outside `within` is still shown by its own label, and an id the plan does not hold is Work stream N / Program N", async () => {
    const first = renderWithProviders(<PlanFilterSelect level="program" value={72} onChange={vi.fn()} within={{ workStreamId: 700 }} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Program" })).toHaveValue("Search (Growth)"));
    first.unmount();
    const second = renderWithProviders(<PlanFilterSelect level="program" value={99} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Program" })).toHaveValue("Program 99"));
    second.unmount();
    renderWithProviders(<PlanFilterSelect level="workStream" value={99} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Work stream" })).toHaveValue("Work stream 99"));
  });

  test("while the plan has not answered the field is blank at every level", async () => {
    mockFetch.mockImplementation(() => new Promise(() => undefined));
    renderWithProviders(<PlanFilterSelect level="program" value={70} onChange={vi.fn()} />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(screen.getByRole("combobox", { name: "Program" })).toHaveValue("");
  });
});
