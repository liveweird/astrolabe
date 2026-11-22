import { useEffect, useState } from "react";
import { localIsoDate } from "../utils/isoDate";

/**
 * The viewer's browser-local calendar day. One timeout is scheduled for the next local midnight (so DST changes are handled by
 * `Date`), and a resumed/focused tab catches up immediately when browsers have throttled that timeout in the background.
 */
export function useLocalToday(): string {
  const [today, setToday] = useState(localIsoDate);

  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      const now = new Date();
      const next = new Date(now);
      next.setHours(24, 0, 0, 0);
      timer = window.setTimeout(refresh, Math.max(1, next.getTime() - now.getTime()));
    };
    const refresh = () => {
      setToday((current) => {
        const next = localIsoDate();
        return next === current ? current : next;
      });
      schedule();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };

    schedule();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return today;
}
