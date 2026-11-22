import { describe, expect, test, vi } from "vitest";
import { renderWithProviders, waitFor } from "../test/render";
import PaginationBar from "./PaginationBar";

describe("PaginationBar", () => {
  test("returns to the last real page when settled data shrinks below the current page", async () => {
    const onPageChange = vi.fn();
    renderWithProviders(<PaginationBar total={20} page={2} pageSize={20} onPageChange={onPageChange} onPageSizeChange={vi.fn()} />);
    await waitFor(() => expect(onPageChange).toHaveBeenCalledWith(1));
  });

  test("does not change a page that still exists", async () => {
    const onPageChange = vi.fn();
    renderWithProviders(<PaginationBar total={21} page={2} pageSize={20} onPageChange={onPageChange} onPageSizeChange={vi.fn()} />);
    await waitFor(() => expect(onPageChange).not.toHaveBeenCalled());
  });
});
