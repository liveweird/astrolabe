import { describe, expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import { useForm } from "@mantine/form";
import { renderWithProviders, screen } from "../test/render";
import { pollIntervalRule, type PollingValues } from "../utils/pollingForm";
import i18n from "../i18n";
import PollingFields from "./PollingFields";

function Harness({ initial }: { initial: PollingValues }) {
  const form = useForm<PollingValues>({ initialValues: initial, validate: { pollIntervalMinutes: pollIntervalRule(i18n.t.bind(i18n)) } });
  return (
    <form onSubmit={form.onSubmit(() => undefined)} noValidate>
      <PollingFields form={form} hint="How often it is read." />
      <button type="submit">go</button>
      <output aria-label="values">{JSON.stringify(form.values)}</output>
    </form>
  );
}

describe("PollingFields", () => {
  test("the fieldset names the interval and the manual-only box, with the connector's hint, and takes the interval typed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={{ pollIntervalMinutes: 60, manualOnly: false }} />);
    expect(screen.getByRole("group", { name: "Polling" })).toBeInTheDocument();
    const interval = screen.getByLabelText("Polling interval (minutes)");
    expect(interval).toHaveValue("60");
    expect(screen.getByText("How often it is read.")).toBeInTheDocument();
    await user.clear(interval);
    await user.type(interval, "30");
    expect(screen.getByLabelText("values")).toHaveTextContent('"pollIntervalMinutes":30');
  });

  test("a typed 3 is refused with the rule's sentence, never clamped", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={{ pollIntervalMinutes: 60, manualOnly: false }} />);
    const interval = screen.getByLabelText("Polling interval (minutes)");
    await user.clear(interval);
    await user.type(interval, "3");
    await user.click(screen.getByRole("button", { name: "go" }));
    expect(await screen.findByText("The polling interval must be a whole number of minutes from 5 to 1440")).toBeInTheDocument();
    expect(interval).toHaveValue("3");
  });

  test("Manual only disables the number and clears its refusal; unticking brings the number back", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={{ pollIntervalMinutes: 60, manualOnly: false }} />);
    const interval = screen.getByLabelText("Polling interval (minutes)");
    await user.clear(interval);
    await user.type(interval, "3");
    await user.click(screen.getByRole("button", { name: "go" }));
    await screen.findByText(/whole number of minutes/);
    const manual = screen.getByRole("checkbox", { name: "Manual only (no polling)" });
    await user.click(manual);
    expect(interval).toBeDisabled();
    expect(screen.queryByText(/whole number of minutes/)).not.toBeInTheDocument();
    await user.click(manual);
    expect(interval).toBeEnabled();
  });
});
