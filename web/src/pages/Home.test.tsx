import { describe, expect, test } from "vitest";
import { renderWithProviders, screen } from "../test/render";
import { headingOutline } from "../test/headings";
import Home from "./Home";

describe("Home", () => {
  test("is a placeholder: the Astrolabe title and a hint that planning views arrive in 0.2", () => {
    renderWithProviders(<Home />);
    expect(screen.getByRole("heading", { level: 2, name: "Astrolabe" })).toBeInTheDocument();
    expect(screen.getByText("Planning views are on their way")).toBeInTheDocument();
    expect(screen.getByText(/arrive in version 0\.2/)).toBeInTheDocument();
    expect(headingOutline()).toEqual([[2, "Astrolabe"]]);
  });
});
