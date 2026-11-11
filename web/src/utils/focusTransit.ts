/**
 * Whether an element still belongs to something that is closing: a dialog's own content or a row menu's item. Such a focus is in transit, not
 * placed: a dialog's content leaves with its fade, and Mantine's return-focus puts the focus back on the menu item that opened the dialog,
 * which stays mounted until the dropdown has faded (about 150 ms) and then drops the focus to `body`. The focus hooks (`useDeleteConfirm`,
 * `useDialogFocus`) therefore keep waiting on it instead of taking it for a place the user chose.
 */
export function isFocusInTransit(element: Element | null): boolean {
  return element !== null && element !== document.body && element.closest('[role="dialog"], [role="menu"]') !== null;
}
