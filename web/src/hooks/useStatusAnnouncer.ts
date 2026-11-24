import { useState } from "react";

/** Zero-width space: toggled on the live-region text so the same sentence twice is announced twice. */
const REREAD = "​";

/** The text of a page's ONE polite status region and the function that says something into it (the same sentence twice is re-read). */
export function useStatusAnnouncer(): readonly [string, (text: string) => void] {
  const [announcement, setAnnouncement] = useState("");
  return [announcement, (text) => setAnnouncement((previous) => (previous.endsWith(REREAD) ? text : text + REREAD))];
}
