import { useParams } from "react-router-dom";
import { legacySavedProposalTarget } from "../utils/legacyLinks";
import LegacyRedirect from "./LegacyRedirect";

/** The retired `/schedule-proposals/saved/:id` page (1.33): a bookmark lands on the Roadmap overview with that saved proposal open (`legacySavedProposalTarget`). */
export default function LegacySavedProposalRedirect() {
  const { to, params } = legacySavedProposalTarget(useParams().id);
  return <LegacyRedirect to={to} params={params} carry={false} />;
}
