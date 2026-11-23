import { describe, expect, test, vi } from "vitest";
import { renderWithProviders } from "../test/render";
import PaginationBar from "./PaginationBar";

describe("PaginationBar", () => {
  test("is presentational: a page past the end is shown as given, never moved by the bar itself", () => {
    const onPageChange = vi.fn();
    renderWithProviders(<PaginationBar total={20} page={2} pageSize={20} onPageChange={onPageChange} onPageSizeChange={vi.fn()} />);
    expect(onPageChange).not.toHaveBeenCalled();
  });
});
