import { describe, expect, test } from "vitest";
import { editUserPath, userFeaturesPath, userPermissionsPath, usersPath, newUserPath } from "./userLinks";

describe("userLinks", () => {
  test("builds the list, create, edit, features and permissions paths", () => {
    expect(usersPath).toBe("/users");
    expect(newUserPath).toBe("/users/new");
    expect(editUserPath(7)).toBe("/users/7/edit");
    expect(userFeaturesPath(7)).toBe("/users/7/features");
    expect(userPermissionsPath(7)).toBe("/users/7/permissions");
  });
});
