import { ActionIcon, Badge, MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { theme } from "./theme";

// Every source file of the app (tests excluded), as text — the scan below reads props off JSX opening tags.
const SOURCES = Object.entries(import.meta.glob<string>("./**/*.tsx", { query: "?raw", import: "default", eager: true })).filter(
  ([path]) => !/\.test\.tsx$/.test(path),
);

/** The attribute text of every `<Name …>` opening tag in `source` (braces and quotes balanced, so `=>` or a ternary inside `{}` does not end it). */
function openingTags(source: string, name: string): string[] {
  const tags: string[] = [];
  for (const start of source.matchAll(new RegExp(`<${name}(?=[\\s>/])`, "g"))) {
    let depth = 0;
    let inString = false;
    let end = start.index + start[0].length;
    for (; end < source.length; end++) {
      const c = source[end];
      if (inString) inString = c !== '"';
      else if (c === '"' && depth === 0) inString = true;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0 && source[end - 1] !== "=") break;
    }
    tags.push(source.slice(start.index, end + 1));
  }
  return tags;
}

/** `file: <Tag …>` for every opening tag of `name` whose text matches `forbidden`. */
function offenders(name: string, forbidden: RegExp): string[] {
  return SOURCES.flatMap(([path, source]) =>
    openingTags(source, name)
      .filter((tag) => forbidden.test(tag))
      .map((tag) => `${path}: ${tag.replace(/\s+/g, " ").slice(0, 80)}`),
  );
}

describe("the theme's component defaults are not passed back (web/CLAUDE.md Theming)", () => {
  it("the theme sets what the pages used to pass", () => {
    expect(theme.components?.Badge?.defaultProps).toMatchObject({ variant: "light", radius: "sm" });
    expect(theme.components?.ActionIcon?.defaultProps).toMatchObject({ variant: "subtle", color: "gray" });
  });

  it("a Badge and an ActionIcon with no props render the theme's variant", () => {
    render(
      <MantineProvider env="test" theme={theme}>
        <Badge>state</Badge>
        <ActionIcon aria-label="act" />
      </MantineProvider>,
    );
    expect(screen.getByText("state").closest(".mantine-Badge-root")).toHaveAttribute("data-variant", "light");
    expect(screen.getByRole("button", { name: "act" })).toHaveAttribute("data-variant", "subtle");
  });

  it("no Badge passes variant=\"light\" and no ActionIcon passes variant=\"subtle\" or color=\"gray\"", () => {
    expect(SOURCES.length).toBeGreaterThan(50); // the glob found the app
    expect(offenders("Badge", /\svariant="light"/)).toEqual([]);
    expect(offenders("ActionIcon", /\s(?:variant="subtle"|color="gray")/)).toEqual([]);
  });
});
