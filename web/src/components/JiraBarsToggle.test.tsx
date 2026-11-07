import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import JiraBarsToggle from "./JiraBarsToggle";
import { renderWithProviders } from "../test/render";

describe("JiraBarsToggle", () => {
  test.each([true, false])("is a button named Jira dates, pressed exactly when the bars are shown (%s)", (shown) => {
    renderWithProviders(<JiraBarsToggle shown={shown} onChange={() => undefined} />);
    expect(screen.getByRole("button", { name: "Jira dates" })).toHaveAttribute("aria-pressed", String(shown));
  });

  test("a press asks for the opposite", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(<JiraBarsToggle shown onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Jira dates" }));
    expect(onChange).toHaveBeenLastCalledWith(false);
    rerender(<JiraBarsToggle shown={false} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Jira dates" }));
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
});
