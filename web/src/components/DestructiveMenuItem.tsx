import type { ComponentPropsWithoutRef } from "react";
import { Menu, type MenuItemProps } from "@mantine/core";
import classes from "../theme.module.css";

/**
 * A menu item that deletes or signs out: the red ink of the theme's AA `inkError` token (and its own quiet red hover tint), never Mantine's
 * `color="red"`, whose red-6 ink is 3.3:1 on the white dropdown and 4.1:1 on the dark one (axe `color-contrast`, found by the e2e sweep over
 * the open row menus). Takes every `Menu.Item` prop except `color`.
 */
export default function DestructiveMenuItem({ className, ...props }: Omit<MenuItemProps, "color"> & Omit<ComponentPropsWithoutRef<"button">, "color" | keyof MenuItemProps>) {
  return <Menu.Item {...props} className={className === undefined ? classes.menuItemDestructive : `${classes.menuItemDestructive} ${className}`} />;
}
