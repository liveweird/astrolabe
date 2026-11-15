import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "../test/render";
import TeamFilterSelect from "./TeamFilterSelect";

const TEAMS = [
  { id: 3, name: "Backend" },
  { id: 4, name: "Frontend" },
];

describe("TeamFilterSelect", () => {
  test("lists the teams, and a pick calls onChange with the id", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<TeamFilterSelect teamId={undefined} onChange={onChange} teams={TEAMS} settled />);
    await user.click(screen.getByRole("combobox", { name: "Team" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Backend", "Frontend"]);
    await user.click(screen.getByRole("option", { name: "Frontend" }));
    expect(onChange).toHaveBeenCalledWith(4);
  });

  test("the clear button calls onChange with undefined", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<TeamFilterSelect teamId={3} onChange={onChange} teams={TEAMS} settled />);
    expect(screen.getByRole("combobox", { name: "Team" })).toHaveValue("Backend");
    await user.click(screen.getByLabelText("Clear team filter"));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  test("an id the settled list does not hold is shown as Team N", () => {
    renderWithProviders(<TeamFilterSelect teamId={99} onChange={vi.fn()} teams={TEAMS} settled />);
    expect(screen.getByRole("combobox", { name: "Team" })).toHaveValue("Team 99");
  });

  test("while the list has not answered the field is blank and no such option exists", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TeamFilterSelect teamId={99} onChange={vi.fn()} teams={[]} settled={false} />);
    const field = screen.getByRole("combobox", { name: "Team" });
    expect(field).toHaveValue("");
    await user.click(field);
    expect(screen.queryByRole("option", { name: "Team 99" })).toBeNull();
  });
});
