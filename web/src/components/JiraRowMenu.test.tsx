import { afterEach, describe, expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { Menu } from "@mantine/core";
import i18n from "../i18n";
import { takeMenuTrigger } from "../utils/menuOpener";
import { renderWithProviders, screen } from "../test/render";
import JiraRowMenu from "./JiraRowMenu";

const trigger = { tabIndex: 0 };

describe("JiraRowMenu", () => {
  afterEach(async () => {
    takeMenuTrigger();
    await i18n.changeLanguage("en");
  });

  test("the kebab is named apart, the item says what it does in its visible text and starts its accessible name with it; a click asks the page", async () => {
    const user = userEvent.setup();
    const onSchedule = vi.fn();
    renderWithProviders(<JiraRowMenu name="Rollout" start="2027-03-01" end="2027-03-05" onSchedule={onSchedule} trigger={trigger} />);
    await user.click(screen.getByRole("button", { name: "Operations for Rollout (dates from Jira)" }));
    const item = await screen.findByRole("menuitem");
    expect(item).toHaveTextContent("Schedule on Jira's dates");
    expect(item).toHaveAccessibleName("Schedule on Jira's dates: Rollout, 2027-03-01 to 2027-03-05");
    await user.click(item);
    expect(onSchedule).toHaveBeenCalledTimes(1);
  });

  test("the page's children come after the item", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <JiraRowMenu name="Rollout" start="2027-03-01" end="2027-03-05" onSchedule={vi.fn()} trigger={trigger}>
        <Menu.Item>Open project</Menu.Item>
      </JiraRowMenu>,
    );
    await user.click(screen.getByRole("button", { name: /Operations for Rollout/ }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["Schedule on Jira's dates", "Open project"]);
  });

  test("in Polish", async () => {
    const user = userEvent.setup();
    await i18n.changeLanguage("pl");
    renderWithProviders(<JiraRowMenu name="Wdrożenie" start="2027-03-01" end="2027-03-05" onSchedule={vi.fn()} trigger={trigger} />);
    await user.click(screen.getByRole("button", { name: "Operacje dla Wdrożenie (daty z Jiry)" }));
    const item = await screen.findByRole("menuitem");
    expect(item).toHaveTextContent("Zaplanuj według dat z Jiry");
    expect(item).toHaveAccessibleName("Zaplanuj według dat z Jiry: Wdrożenie, od 2027-03-01 do 2027-03-05");
  });
});
