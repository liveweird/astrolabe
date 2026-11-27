import { useLocation } from "react-router-dom";
import { legacyMilestonesTarget } from "../utils/legacyLinks";
import LegacyRedirect from "./LegacyRedirect";

/** The retired `/milestones` page (1.29): a bookmark lands on its project's page (its Unscheduled section for `scheduled=false`), its team's page, or the Projects page (`legacyMilestonesTarget`). */
export default function LegacyMilestonesRedirect() {
  const { search } = useLocation();
  const { to, params } = legacyMilestonesTarget(search);
  return <LegacyRedirect to={to} params={params} carry={false} />;
}
