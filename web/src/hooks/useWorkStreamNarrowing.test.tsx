import type { ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ProgramsView } from "../api/programs";
import { useWorkStreamNarrowing } from "./useWorkStreamNarrowing";

// The overview's work stream narrowing (1.31): the address's alone. The page's behaviour: pages/Programs.narrow.test.tsx.

const view = (...ids: number[]) => ({ workStreams: ids.map((id) => ({ id, name: `Stream ${id}` })) }) as unknown as ProgramsView;

function setup(route: string, initial: { view: ProgramsView; settled: boolean }) {
  const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
  return renderHook((props: { view: ProgramsView; settled: boolean }) => ({ narrowing: useWorkStreamNarrowing(props.view, props.settled), location: useLocation() }), { wrapper, initialProps: initial });
}

describe("useWorkStreamNarrowing", () => {
  test("a work stream the plan has is the narrowing, the address untouched", () => {
    const { result } = setup("/roadmap?mode=overview&workStreamId=2", { view: view(1, 2), settled: true });
    expect(result.current.narrowing.workStream?.id).toBe(2);
    expect(result.current.narrowing.unknown).toBe(false);
    expect(result.current.location.search).toBe("?mode=overview&workStreamId=2");
  });

  test("set writes the parameter by replace and clears it, keeping the others", () => {
    const { result } = setup("/roadmap?mode=overview&programId=4", { view: view(1, 2), settled: true });
    act(() => result.current.narrowing.set(1));
    expect(result.current.location.search).toBe("?mode=overview&programId=4&workStreamId=1");
    act(() => result.current.narrowing.set(null));
    expect(result.current.location.search).toBe("?mode=overview&programId=4");
  });

  test("an unknown id drops the narrowing and the parameter and says so, once the read has settled", () => {
    const { result } = setup("/roadmap?mode=overview&workStreamId=9", { view: view(1), settled: true });
    expect(result.current.narrowing.workStream).toBeNull();
    expect(result.current.narrowing.unknown).toBe(true);
    expect(result.current.location.search).toBe("?mode=overview");
    act(() => result.current.narrowing.dismiss());
    expect(result.current.narrowing.unknown).toBe(false);
  });

  test("while a read is in flight a missing work stream is not judged: it may be one created a moment ago", () => {
    const { result, rerender } = setup("/roadmap?mode=overview&workStreamId=9", { view: view(1), settled: false });
    expect(result.current.narrowing.unknown).toBe(false);
    expect(result.current.location.search).toBe("?mode=overview&workStreamId=9");
    rerender({ view: view(1, 9), settled: false });
    expect(result.current.narrowing.workStream?.id).toBe(9);
    expect(result.current.narrowing.unknown).toBe(false);
  });

  test("a malformed id is unknown too; no parameter is no narrowing and no notice", () => {
    expect(setup("/roadmap?mode=overview&workStreamId=abc", { view: view(1), settled: true }).result.current.narrowing.unknown).toBe(true);
    const bare = setup("/roadmap?mode=overview", { view: view(1), settled: true }).result.current.narrowing;
    expect(bare.workStream).toBeNull();
    expect(bare.unknown).toBe(false);
  });
});
