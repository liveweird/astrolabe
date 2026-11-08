import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { Text } from "@mantine/core";
import { isFlowAlreadyBound } from "../api/flow";
import { ApiError } from "../api/http";
import { saveErrorMessage } from "./saveError";

/** A refused link: the fixed lead, and under it the server's own sentence for a 400 / 409 (it names the team or the Flow team; it never quotes a secret). */
export function linkFailure(err: unknown, t: TFunction): ReactNode {
  const lead = saveErrorMessage(err, t, {
    forbidden: "flow.teams.linkForbidden",
    notFound: "flow.saveGone",
    conflict: "flow.teams.linkConflict",
    invalid: "flow.teams.linkInvalid",
    failed: "flow.teams.linkFailed",
  });
  const detail = err instanceof ApiError && (isFlowAlreadyBound(err) || err.status === 400) ? err.detail : undefined;
  return (
    <>
      <Text size="sm">{lead}</Text>
      {detail && (
        <Text size="sm" mt={4}>
          {detail}
        </Text>
      )}
    </>
  );
}
