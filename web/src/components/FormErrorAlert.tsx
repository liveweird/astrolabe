import type { Ref } from "react";
import { Alert, type AlertProps } from "@mantine/core";

/**
 * The inline failure alert for a form or an action: a message the caller already mapped to words
 * (`saveErrorMessage`, a validation sentence) — red and light, never a toast. A failed QUERY goes
 * through `ErrorAlert`, which maps the error itself. Mantine's `Alert` is already `role="alert"`.
 */
export default function FormErrorAlert({ ref, ...props }: Omit<AlertProps, "color" | "variant"> & { ref?: Ref<HTMLDivElement> }) {
  return <Alert ref={ref} color="red" variant="light" {...props} />;
}
