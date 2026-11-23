import { describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { PAGE_SIZE_OPTIONS, useClampPage, usePagedSort } from "./usePagedSort";

const SORT_FIELDS = ["name", "kind", "updatedAt"] as const;
type SortField = (typeof SORT_FIELDS)[number];

const PERSIST = { key: "testView", sortFields: SORT_FIELDS };
const STORAGE_KEY = "astrolabe.viewSettings.testView.paging";

function renderPagedSort(deps: unknown[] = [""], persist?: typeof PERSIST) {
  return renderHook(({ filterDeps }) => usePagedSort<SortField>("name", filterDeps, persist), {
    initialProps: { filterDeps: deps },
  });
}

describe("usePagedSort", () => {
  test("initial state: page 1, default page size, initial field ascending", () => {
    const { result } = renderPagedSort();
    expect(result.current.page).toBe(1);
    expect(result.current.pageSize).toBe(20);
    expect(result.current.sortField).toBe("name");
    expect(result.current.sortDir).toBe("asc");
    expect(result.current.sortParam).toBe("name");
  });

  test("toggleSort on the active field cycles asc → desc → asc; sortParam prefixes '-' for desc", () => {
    const { result } = renderPagedSort();

    act(() => result.current.toggleSort("name"));
    expect(result.current.sortDir).toBe("desc");
    expect(result.current.sortParam).toBe("-name");

    act(() => result.current.toggleSort("name"));
    expect(result.current.sortDir).toBe("asc");
    expect(result.current.sortParam).toBe("name");
  });

  test("toggleSort on another field switches to it ascending", () => {
    const { result } = renderPagedSort();
    act(() => result.current.toggleSort("name")); // name desc
    act(() => result.current.toggleSort("kind"));
    expect(result.current.sortField).toBe("kind");
    expect(result.current.sortDir).toBe("asc");
    expect(result.current.sortParam).toBe("kind");
  });

  test("a filterDeps change resets the page to 1", () => {
    const { result, rerender } = renderPagedSort(["initial"]);
    act(() => result.current.setPage(3));
    expect(result.current.page).toBe(3);

    rerender({ filterDeps: ["changed"] });
    expect(result.current.page).toBe(1);
  });

  test("a sort change resets the page to 1", () => {
    const { result } = renderPagedSort();
    act(() => result.current.setPage(2));
    act(() => result.current.toggleSort("kind"));
    expect(result.current.page).toBe(1);
  });

  test("setPageSize changes the size and resets the page to 1", () => {
    const { result } = renderPagedSort();
    act(() => result.current.setPage(4));
    act(() => result.current.setPageSize(40));
    expect(result.current.pageSize).toBe(40);
    expect(result.current.page).toBe(1);
  });

  test("with persist, sort and page size are stored and restored on a fresh mount", () => {
    const { result } = renderPagedSort([""], PERSIST);
    act(() => result.current.toggleSort("updatedAt"));
    act(() => result.current.toggleSort("updatedAt")); // updatedAt desc
    act(() => result.current.setPageSize(60));

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      sortField: "updatedAt",
      sortDir: "desc",
      pageSize: 60,
    });

    const { result: remounted } = renderPagedSort([""], PERSIST);
    expect(remounted.current.sortField).toBe("updatedAt");
    expect(remounted.current.sortDir).toBe("desc");
    expect(remounted.current.pageSize).toBe(60);
    expect(remounted.current.sortParam).toBe("-updatedAt");
  });

  test("stale or invalid stored paging silently falls back to the defaults", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sortField: "removedColumn", sortDir: "sideways", pageSize: 33 }),
    );
    const { result } = renderPagedSort([""], PERSIST);
    expect(result.current.sortField).toBe("name");
    expect(result.current.sortDir).toBe("asc");
    expect(result.current.pageSize).toBe(20);
  });

  test("without persist nothing is written to storage", () => {
    const { result } = renderPagedSort([""]);
    act(() => result.current.toggleSort("kind"));
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("PAGE_SIZE_OPTIONS is the 20/40/60 ladder", () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([20, 40, 60]);
  });
});

describe("useClampPage", () => {
  type Answer = { total: number } | undefined;
  function renderClamp(initial: { page: number; data: Answer; isPlaceholderData?: boolean }) {
    const setPage = vi.fn();
    const view = renderHook(
      (p: { page: number; data: Answer; isPlaceholderData?: boolean }) =>
        useClampPage(p.page, 20, setPage, p.data, p.isPlaceholderData ?? false),
      { initialProps: initial },
    );
    return { setPage, ...view };
  }

  test("a settled answer that shrank below the current page returns to the last real page", () => {
    const { setPage, rerender } = renderClamp({ page: 3, data: { total: 100 } });
    expect(setPage).not.toHaveBeenCalled();
    rerender({ page: 3, data: { total: 25 } });
    expect(setPage).toHaveBeenCalledWith(2);
  });

  test("an empty settled list clamps to page 1", () => {
    const { setPage } = renderClamp({ page: 2, data: { total: 0 } });
    expect(setPage).toHaveBeenCalledWith(1);
  });

  test("a page that still exists is left alone", () => {
    const { setPage } = renderClamp({ page: 2, data: { total: 21 } });
    expect(setPage).not.toHaveBeenCalled();
  });

  test("a failed or still-loading request (no data) never changes the page", () => {
    const { setPage, rerender } = renderClamp({ page: 3, data: undefined });
    rerender({ page: 3, data: undefined });
    expect(setPage).not.toHaveBeenCalled();
  });

  test("a keepPreviousData placeholder is not a settled answer", () => {
    const { setPage } = renderClamp({ page: 3, data: { total: 5 }, isPlaceholderData: true });
    expect(setPage).not.toHaveBeenCalled();
  });
});
