/**
 * A rendered DOM string with every per-mount generated id replaced by `ID` and the theme provider's `<style>` blocks dropped,
 * so two mounts of the same tree can be compared with `toBe`. Covers React's `useId` (`:r1:`, `_r_1_`), dnd-kit's
 * `DndDescribedBy-N` / `DndLiveRegion-N` and Mantine's `useId`.
 *
 * Mantine's id is `Math.random().toString(36).slice(2, 11)`: AT MOST 9 characters, and 7 or 8 about once in 5,000 draws
 * (a base-36 expansion that ends early), so the pattern takes 1..9. It is applied only inside the attributes that carry an id
 * (`id`, `for`, `name`, `aria-*`; a list attribute has one token per id) so Mantine's own lowercase class tokens
 * (`mantine-focus-auto`) and CSS variables stay verbatim in the comparison.
 */
export function withoutGeneratedIds(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/\b(?:id|for|name|aria-[a-z]+)="[^"]*"/g, (attribute) => attribute.replace(/mantine-[a-z0-9]{1,9}(?![a-z0-9])/g, "ID"))
    .replace(/DndDescribedBy-\d+|DndLiveRegion-\d+|:r[0-9a-z]+:|_r_[0-9a-z]+_/g, "ID");
}
