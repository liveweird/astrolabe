import { describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Table } from "@mantine/core";
import { renderWithProviders, screen } from "../test/render";
import SortHeader from "./SortHeader";

function renderHeader(activeField: "name" | "email", activeDir: "asc" | "desc", onToggle = vi.fn()) {
  renderWithProviders(
    <Table>
      <Table.Thead>
        <Table.Tr>
          <SortHeader field="name" label="Name" activeField={activeField} activeDir={activeDir} onToggle={onToggle} />
          <SortHeader field="email" label="Email" activeField={activeField} activeDir={activeDir} onToggle={onToggle} width={120} />
        </Table.Tr>
      </Table.Thead>
    </Table>,
  );
  return onToggle;
}

describe("SortHeader", () => {
  test("the active column carries aria-sort for its direction, the others none", () => {
    renderHeader("name", "asc");
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByRole("columnheader", { name: "Email" })).toHaveAttribute("aria-sort", "none");
  });

  test("descending reads as descending, and a click asks to toggle that field", async () => {
    const onToggle = renderHeader("email", "desc");
    expect(screen.getByRole("columnheader", { name: "Email" })).toHaveAttribute("aria-sort", "descending");
    await userEvent.setup().click(screen.getByRole("button", { name: "Name" }));
    expect(onToggle).toHaveBeenCalledWith("name");
  });
});
