import { afterEach, describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { DateInput } from "@mantine/dates";
import { screen } from "@testing-library/react";
import i18n from "../i18n";
import AppDatesProvider from "./AppDatesProvider";
import { renderWithProviders } from "../test/render";

describe("AppDatesProvider", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  test("the calendar follows the UI language while the value text stays ISO", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AppDatesProvider>
        <DateInput label="Day" value="2026-03-10" valueFormat="YYYY-MM-DD" />
      </AppDatesProvider>,
    );
    const input = screen.getByLabelText("Day");
    expect(input).toHaveValue("2026-03-10");
    await user.click(input);
    expect(await screen.findByText("March 2026")).toBeInTheDocument();
  });

  test("Polish month names once the UI is Polish, weeks starting on Monday", async () => {
    await i18n.changeLanguage("pl");
    const user = userEvent.setup();
    renderWithProviders(
      <AppDatesProvider>
        <DateInput label="Dzień" value="2026-03-10" valueFormat="YYYY-MM-DD" />
      </AppDatesProvider>,
    );
    const input = screen.getByLabelText("Dzień");
    expect(input).toHaveValue("2026-03-10");
    await user.click(input);
    expect(await screen.findByText("marzec 2026")).toBeInTheDocument();
    const weekdays = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(weekdays[0]).toBe("Pn");
  });
});
