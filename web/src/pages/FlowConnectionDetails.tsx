import { getFlowConnection } from "../api/flow";
import ConnectionDetailsPage from "../components/ConnectionDetailsPage";
import FlowConnectionEditorModal from "../components/FlowConnectionEditorModal";
import FlowConnectionSection from "../components/FlowConnectionSection";
import FlowTeamsSection from "../components/FlowTeamsSection";
import { flowConnectionsPath } from "../utils/flowLinks";

/**
 * One Flow connection (`/integrations/flow/:id`, ADMIN only): the Connection section (facts, Test connection, Refresh now, the runs) and the
 * Teams section (the mirrored Flow teams, their links to Astrolabe teams, "Link all suggested").
 * The shell (route id, load triage, header, editor) is `ConnectionDetailsPage`.
 */
export default function FlowConnectionDetails() {
  return (
    <ConnectionDetailsPage
      kind="flow"
      connectionsPath={flowConnectionsPath}
      fetchConnection={getFlowConnection}
      sections={(connection, readAt) => (
        <>
          <FlowConnectionSection connection={connection} readAt={readAt} />
          <FlowTeamsSection connection={connection} />
        </>
      )}
      Editor={FlowConnectionEditorModal}
    />
  );
}
