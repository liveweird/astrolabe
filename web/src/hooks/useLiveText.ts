import { useEffect, useState } from "react";

/**
 * The text for a live region that is ALWAYS rendered (`VisuallyHidden role="status"`), filled one tick AFTER the render that has the words: a status region
 * inserted together with its text is not reliably announced, one that exists empty and then receives text is. A notice that appears while the page loads or
 * after an address was followed (a milestone or work stream the plan lacks) says itself through it, beside its visible, role-less Alert.
 */
export function useLiveText(text: string): string {
  const [said, setSaid] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSaid(text), 0);
    return () => clearTimeout(timer);
  }, [text]);
  return said;
}
