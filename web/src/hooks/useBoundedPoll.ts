import { useRef } from "react";
import { RUN_POLL_MAX_MS, RUN_POLL_MS } from "../utils/syncRuns";

/**
 * The `refetchInterval` rule of a view that follows running runs: `poll(liveKey)` answers the period while something is running and
 * `false` when nothing is. `liveKey` NAMES what is running (the newest running run's id, or the ids of every running connection's run):
 * the safety bound (`RUN_POLL_MAX_MS`, measured from when this key was first seen) latches on that key, so a NEW claim after the bound
 * is a new key and polls again, while the same stuck run does not keep a tab polling for ever.
 */
export function useBoundedPoll(): (liveKey: string | null) => number | false {
  const latch = useRef<{ key: string; since: number } | null>(null);
  return (liveKey) => {
    if (liveKey === null) {
      latch.current = null;
      return false;
    }
    const now = Date.now();
    if (latch.current?.key !== liveKey) latch.current = { key: liveKey, since: now };
    return now - latch.current.since > RUN_POLL_MAX_MS ? false : RUN_POLL_MS;
  };
}
