import { useEffect, useState } from "react";

/**
 * The current time (epoch millis), re-read every `periodMs` (a minute by default): "next poll in 7 min" must not freeze at the moment the
 * page was fetched. A relative wording only; nothing is decided on this clock (the server's `running` verdict and `nextPollAt` are).
 * `readAt` (a query's `dataUpdatedAt`) is a floor: figures read mid-minute are compared with the moment they were read, never with an
 * older tick (a connection that is due NOW must not read "next poll in 1 min").
 */
export function useNow(periodMs = 60_000, readAt = 0): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [periodMs]);
  return Math.max(now, readAt);
}
