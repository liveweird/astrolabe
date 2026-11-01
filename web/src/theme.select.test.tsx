import { MantineProvider, MultiSelect, Select } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { theme } from "./theme";

const MANY = Array.from({ length: 100 }, (_, i) => ({ value: String(i), label: `Project ${i}` }));

// The real axe proof is the overflow + keyboard + axe test in e2e/tests/dependencies.spec.ts; happy-dom has no layout, so this pins the structure
// that scan relies on: the listbox holds the options directly (no inner ScrollArea viewport, which axe flags once it overflows).
describe("theme: option lists scroll in the listbox itself", () => {
  it.each([
    ["Select", <Select key="s" label="Pick" data={MANY} searchable />],
    ["MultiSelect", <MultiSelect key="m" label="Pick" data={MANY} searchable />],
  ])("a %s dropdown has no inner scroll viewport and still filters accent-insensitively", async (_name, element) => {
    render(
      <MantineProvider env="test" theme={theme}>
        {element}
      </MantineProvider>,
    );
    const input = screen.getByRole("combobox", { name: "Pick" });
    fireEvent.click(input);
    const listbox = screen.getByRole("listbox");
    expect(screen.getAllByRole("option")).toHaveLength(100);
    expect(listbox.querySelector("[data-mantine-scrollbar], .mantine-ScrollArea-viewport")).toBeNull();
    // The options are direct children of the listbox, which carries the theme's scroller class.
    expect(screen.getAllByRole("option")[0].parentElement).toBe(listbox);
    expect(listbox.className).toMatch(/comboboxOptions/);

    await userEvent.setup().type(input, "project 42");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
  });
});
