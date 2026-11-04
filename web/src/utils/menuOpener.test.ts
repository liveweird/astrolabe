import { afterEach, describe, expect, test } from "vitest";
import { rememberMenuTrigger, takeMenuTrigger } from "./menuOpener";

function scaffold() {
  document.body.innerHTML = `<button id="kebab">Operations</button><div role="menu" aria-labelledby="kebab"><button id="item" role="menuitem"><span id="label">Edit</span></button></div><button id="plain">Plain</button>`;
  return {
    kebab: document.getElementById("kebab")!,
    item: document.getElementById("item")!,
    label: document.getElementById("label")!,
    plain: document.getElementById("plain")!,
  };
}

describe("menuOpener", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    takeMenuTrigger();
  });

  test("an element inside a menu remembers the menu's trigger, and take hands it out once", () => {
    const { kebab, label } = scaffold();
    rememberMenuTrigger(label);
    expect(takeMenuTrigger()).toBe(kebab);
    expect(takeMenuTrigger()).toBeNull();
  });

  test("an element outside any menu gives null, and replaces an earlier memory", () => {
    const { item, plain } = scaffold();
    rememberMenuTrigger(item);
    rememberMenuTrigger(plain);
    expect(takeMenuTrigger()).toBeNull();
  });

  test("a menu whose trigger id is unknown gives null", () => {
    const { item, kebab } = scaffold();
    kebab.remove();
    rememberMenuTrigger(item);
    expect(takeMenuTrigger()).toBeNull();
  });

  test("the memory expires at the end of the click: a later take (a dialog opened from a plain button) finds nothing", async () => {
    const { item } = scaffold();
    rememberMenuTrigger(item);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(takeMenuTrigger()).toBeNull();
  });

  test("a take in the same task still finds it", async () => {
    const { item, kebab } = scaffold();
    rememberMenuTrigger(item);
    await Promise.resolve();
    expect(takeMenuTrigger()).toBe(kebab);
  });
});
