/**
 * A `getByText` matcher for a sentence that has links inside it (1.31: a name in a translated sentence is an `EntityLink`, so the sentence is no longer one text node):
 * the innermost element whose whole text content is `text` (a string, whitespace-normalised, or a pattern).
 */
export function textContent(text: string | RegExp): (content: string, element: Element | null) => boolean {
  const matches = (value: string | null): boolean => {
    const normalised = (value ?? "").replace(/\s+/g, " ").trim();
    return typeof text === "string" ? normalised === text : text.test(normalised);
  };
  return (_content, element) => element !== null && matches(element.textContent) && !Array.from(element.children).some((child) => matches(child.textContent));
}
