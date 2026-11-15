import type { Icon } from "@tabler/icons-react";
import { IconExternalLink } from "@tabler/icons-react";

/**
 * The small icon that trails a link's text (an external link by default; the team glyph of the Roadmap flag panel): 0.85em, hidden from
 * assistive technology (the link carries its own name), a quarter-em from the text and nudged onto its baseline.
 */
export default function TrailingLinkIcon({ icon: Glyph = IconExternalLink }: { icon?: Icon }) {
  return <Glyph size="0.85em" aria-hidden style={{ marginInlineStart: "0.25em", verticalAlign: "-0.1em" }} />;
}
