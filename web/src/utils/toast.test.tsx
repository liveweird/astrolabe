import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MantineProvider } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { act, render, screen } from "@testing-library/react";
import i18n from "../i18n";
import { theme } from "../theme";
import { showSuccessToast } from "./toast";

describe("showSuccessToast", () => {
  // The notification store is module-level and the suite shares modules (isolate: false): another file's toast may still be in it.
  beforeEach(() => {
    notifications.clean();
  });
  afterEach(async () => {
    notifications.clean();
    await i18n.changeLanguage("en");
  });

  it("gives the toast's close button an accessible name, in the active language", async () => {
    render(
      <MantineProvider env="test" theme={theme}>
        <Notifications />
      </MantineProvider>,
    );

    act(() => showSuccessToast("Saved"));
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close notification" })).toBeTruthy();

    notifications.clean();
    await i18n.changeLanguage("pl");
    act(() => showSuccessToast("Zapisano"));
    expect(await screen.findByText("Zapisano")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zamknij powiadomienie" })).toBeTruthy();
  });
});
