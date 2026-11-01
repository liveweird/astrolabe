import { useState } from "react";

/**
 * "A change was refused because a save was still running": the flag a page shows (and announces) until THAT save is over. It is set by
 * the write path that refuses and cleared the moment `busy` turns false — whichever write was the busy one (the page's schedule save,
 * its order save), so a refusal never outlives the save that caused it. Derived during render (no effect): when `busy` changes to false
 * the flag is reset in the same pass.
 */
export function useRefusal(busy: boolean): [refused: boolean, setRefused: (refused: boolean) => void] {
  const [refused, setRefused] = useState(false);
  const [wasBusy, setWasBusy] = useState(busy);
  if (wasBusy !== busy) {
    setWasBusy(busy);
    if (!busy) setRefused(false);
  }
  return [refused, setRefused];
}
