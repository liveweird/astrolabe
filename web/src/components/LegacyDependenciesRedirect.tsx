import { useLocation } from "react-router-dom";
import { legacyDependenciesTarget } from "../utils/legacyLinks";
import LegacyRedirect from "./LegacyRedirect";

/** The retired `/dependencies` page (1.29): a bookmark lands on the Roadmap with its dependency panel open and filtered (`legacyDependenciesTarget`); nothing else of the old query is kept (its `teamId` would be the Roadmap's own filter). */
export default function LegacyDependenciesRedirect() {
  const { search } = useLocation();
  const { to, params } = legacyDependenciesTarget(search);
  return <LegacyRedirect to={to} params={params} carry={false} />;
}
